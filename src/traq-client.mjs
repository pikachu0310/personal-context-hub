import {
  TRAQ_API_BASE,
  TRAQ_OAUTH_SCOPES,
  TRAQ_REDIRECT_URI,
  readTokenStore,
  writeTokenStore,
} from "./config.mjs";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DIRECTORY_CACHE_MS = 5 * 60 * 1000;
const TOKEN_CACHE_MS = 60 * 1000;

export function buildMessageSearchParams(input) {
  const params = new URLSearchParams();
  const scalarFields = [
    ["word", input.word],
    ["after", input.after],
    ["before", input.before],
    ["in", input.channelId],
    ["citation", input.citationId],
    ["bot", input.bot],
    ["hasURL", input.hasUrl],
    ["hasAttachments", input.hasAttachments],
    ["hasImage", input.hasImage],
    ["hasVideo", input.hasVideo],
    ["hasAudio", input.hasAudio],
    ["limit", input.limit],
    ["offset", input.offset],
    ["sort", input.sort],
  ];

  for (const [key, value] of scalarFields) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  for (const userId of input.toUserIds ?? []) params.append("to", userId);
  for (const userId of input.fromUserIds ?? []) params.append("from", userId);
  return params;
}

export function buildChannelPaths(channels) {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const memo = new Map();

  const visit = (channel, seen = new Set()) => {
    if (memo.has(channel.id)) return memo.get(channel.id);
    if (seen.has(channel.id)) return channel.name;
    seen.add(channel.id);

    const parent = channel.parentId ? byId.get(channel.parentId) : undefined;
    const path = parent
      ? `${visit(parent, seen)}/${channel.name}`
      : channel.name;
    memo.set(channel.id, path);
    return path;
  };

  return new Map(channels.map((channel) => [channel.id, visit(channel)]));
}

export function normalizeWritePath(path) {
  const trimmed = path.trim();
  let decoded;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    throw new Error("The traQ API path contains invalid escaping.");
  }
  if (
    !trimmed ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    /(^|\/)\.\.($|[/?#])/.test(decoded)
  ) {
    throw new Error("Use a safe path relative to the traQ v3 API.");
  }
  const normalized = trimmed.replace(/^\/+/, "");
  const sensitiveControlPlane = [
    /^oauth2(?:\/|$)/i,
    /^clients(?:\/|$)/i,
    /^users\/me\/(?:tokens|sessions)(?:\/|$)/i,
    /^bots\/[^/]+\/actions\/reissue(?:\/|$)/i,
  ];
  if (sensitiveControlPlane.some((pattern) => pattern.test(normalized))) {
    throw new Error(
      "Credential, session, and token-reissue endpoints are disabled in the generic write tool.",
    );
  }
  return normalized;
}

export class TraqClient {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetchImpl = fetchImpl;
    this.directoryCache = undefined;
    this.tokenCache = undefined;
  }

  async refreshAccessToken(token) {
    if (!token.refreshToken) {
      throw new Error(
        "The traQ access token expired and no refresh token exists.",
      );
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: token.clientId,
      refresh_token: token.refreshToken,
    });
    const response = await this.fetchImpl(
      new URL("oauth2/token", TRAQ_API_BASE),
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
    );
    if (!response.ok) {
      throw new Error(`traQ token refresh failed (${response.status}).`);
    }

    const refreshed = await response.json();
    const next = {
      ...token,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? token.refreshToken,
      tokenType: refreshed.token_type ?? "Bearer",
      scope: refreshed.scope ?? token.scope,
      expiresAt: Date.now() + Number(refreshed.expires_in ?? 0) * 1000,
      refreshedAt: new Date().toISOString(),
    };
    await writeTokenStore(next);
    this.tokenCache = { token: next, loadedAt: Date.now() };
    return next;
  }

  async getToken({ forceRefresh = false } = {}) {
    const now = Date.now();
    const token =
      !forceRefresh &&
      this.tokenCache &&
      this.tokenCache.loadedAt > now - TOKEN_CACHE_MS
        ? this.tokenCache.token
        : await readTokenStore();
    this.tokenCache = { token, loadedAt: now };
    if (token.expiresAt <= now + REFRESH_MARGIN_MS) {
      return this.refreshAccessToken(token);
    }
    return token;
  }

  async request(
    path,
    { method = "GET", searchParams, json, retry = true } = {},
  ) {
    const token = await this.getToken();
    const url = new URL(path.replace(/^\//, ""), TRAQ_API_BASE);
    if (searchParams) url.search = searchParams.toString();

    const headers = {
      accept: "application/json",
      authorization: `${token.tokenType ?? "Bearer"} ${token.accessToken}`,
    };
    if (json !== undefined) headers["content-type"] = "application/json";

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });

    if (response.status === 401 && retry) {
      const stored = await readTokenStore();
      if (stored.accessToken !== token.accessToken) {
        this.tokenCache = { token: stored, loadedAt: Date.now() };
        return this.request(path, {
          method,
          searchParams,
          json,
          retry: false,
        });
      }
      if (stored.refreshToken) {
        await this.refreshAccessToken(stored);
        return this.request(path, {
          method,
          searchParams,
          json,
          retry: false,
        });
      }
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(
        `traQ API ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
      );
    }
    if (response.status === 204) return undefined;
    return response.json();
  }

  async whoami() {
    return this.request("users/me");
  }

  async searchMessages(input) {
    const hasFilter = Object.entries(input).some(
      ([key, value]) =>
        !["limit", "offset", "sort"].includes(key) &&
        value !== undefined &&
        value !== null &&
        value !== "" &&
        (!Array.isArray(value) || value.length > 0),
    );
    if (!hasFilter) {
      throw new Error("Specify at least one search filter.");
    }
    const result = await this.request("messages", {
      searchParams: buildMessageSearchParams(input),
    });
    return {
      totalHits: result.totalHits,
      hits: await this.enrichMessages(result.hits),
    };
  }

  async getMessage(messageId) {
    const message = await this.request(`messages/${messageId}`);
    return this.enrichMessage(message);
  }

  async getChannelMessages(channelId, input = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of [
      ["limit", input.limit],
      ["offset", input.offset],
      ["since", input.since],
      ["until", input.until],
      ["inclusive", input.inclusive],
      ["order", input.order],
    ]) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    }
    const messages = await this.request(`channels/${channelId}/messages`, {
      searchParams: params,
    });
    return this.enrichMessages(messages);
  }

  async getChannel(channelId) {
    return this.request(`channels/${channelId}`);
  }

  async getUser(userId) {
    return this.request(`users/${userId}`);
  }

  async postMessage(channelId, input) {
    const message = await this.request(`channels/${channelId}/messages`, {
      method: "POST",
      json: input,
    });
    return this.enrichMessage(message);
  }

  async postDirectMessage(userId, input) {
    const message = await this.request(`users/${userId}/messages`, {
      method: "POST",
      json: input,
    });
    return this.enrichMessage(message);
  }

  async editMessage(messageId, input) {
    await this.request(`messages/${messageId}`, {
      method: "PUT",
      json: input,
    });
    return this.getMessage(messageId);
  }

  async deleteMessage(messageId) {
    await this.request(`messages/${messageId}`, { method: "DELETE" });
    return { deleted: true, messageId };
  }

  async getMessageStamps(messageId) {
    return this.request(`messages/${messageId}/stamps`);
  }

  async addMessageStamp(messageId, stampId, count = 1) {
    await this.request(`messages/${messageId}/stamps/${stampId}`, {
      method: "POST",
      json: { count },
    });
    return { added: true, messageId, stampId, count };
  }

  async removeMessageStamp(messageId, stampId) {
    await this.request(`messages/${messageId}/stamps/${stampId}`, {
      method: "DELETE",
    });
    return { removed: true, messageId, stampId };
  }

  async pinMessage(messageId) {
    const pin = await this.request(`messages/${messageId}/pin`, {
      method: "POST",
    });
    return pin ?? { pinned: true, messageId };
  }

  async unpinMessage(messageId) {
    await this.request(`messages/${messageId}/pin`, { method: "DELETE" });
    return { pinned: false, messageId };
  }

  async searchStamps(query) {
    const stamps = await this.request("stamps");
    const normalized = query.trim().toLocaleLowerCase();
    return stamps
      .filter((stamp) => stamp.name.toLocaleLowerCase().includes(normalized))
      .slice(0, 50);
  }

  async createChannel(input) {
    const channel = await this.request("channels", {
      method: "POST",
      json: input,
    });
    this.directoryCache = undefined;
    return channel;
  }

  async updateChannel(channelId, input) {
    const channel = await this.request(`channels/${channelId}`, {
      method: "PATCH",
      json: input,
    });
    this.directoryCache = undefined;
    return channel ?? this.getChannel(channelId);
  }

  async setChannelTopic(channelId, topic) {
    const channelTopic = await this.request(`channels/${channelId}/topic`, {
      method: "PUT",
      json: { topic },
    });
    return channelTopic ?? { channelId, topic };
  }

  async listBots() {
    return this.request("bots");
  }

  async getBot(botId) {
    return this.request(`bots/${botId}`);
  }

  async apiWrite({ method, path, body }) {
    const normalizedMethod = method.toUpperCase();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod)) {
      throw new Error("Only POST, PUT, PATCH, and DELETE are allowed.");
    }
    const normalizedPath = normalizeWritePath(path);
    const response = await this.request(normalizedPath, {
      method: normalizedMethod,
      json: body,
    });
    return (
      response ?? {
        ok: true,
        method: normalizedMethod,
        path: normalizedPath,
      }
    );
  }

  async getDirectory() {
    if (this.directoryCache && this.directoryCache.expiresAt > Date.now()) {
      return this.directoryCache;
    }

    const [users, channelList] = await Promise.all([
      this.request("users"),
      this.request("channels"),
    ]);
    const channels = Array.isArray(channelList)
      ? channelList
      : (channelList.public ?? []);
    const paths = buildChannelPaths(channels);
    this.directoryCache = {
      expiresAt: Date.now() + DIRECTORY_CACHE_MS,
      users: new Map(users.map((user) => [user.id, user])),
      channels: new Map(channels.map((channel) => [channel.id, channel])),
      paths,
    };
    return this.directoryCache;
  }

  async resolveChannel(query) {
    const directory = await this.getDirectory();
    const normalized = query.replace(/^#/, "").toLocaleLowerCase();
    return [...directory.channels.values()]
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        path: directory.paths.get(channel.id) ?? channel.name,
        archived: channel.archived,
      }))
      .filter(
        (channel) =>
          channel.name.toLocaleLowerCase() === normalized ||
          channel.path.toLocaleLowerCase() === normalized ||
          channel.path.toLocaleLowerCase().includes(normalized),
      )
      .sort((a, b) => a.path.length - b.path.length)
      .slice(0, 25);
  }

  async enrichMessages(messages) {
    const directory = await this.getDirectory();
    return Promise.all(
      messages.map((message) => this.enrichMessage(message, directory)),
    );
  }

  async enrichMessage(message, knownDirectory) {
    const directory = knownDirectory ?? (await this.getDirectory());
    const user = directory.users.get(message.userId);
    const channelPath = directory.paths.get(message.channelId);
    return {
      id: message.id,
      content: message.content,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      pinned: message.pinned,
      user: user
        ? {
            id: user.id,
            name: user.name,
            displayName: user.displayName,
            bot: user.bot,
          }
        : { id: message.userId },
      channel: {
        id: message.channelId,
        path: channelPath,
      },
      attachments: message.attachments ?? [],
      link: `https://q.trap.jp/messages/${message.id}`,
    };
  }
}

export async function exchangeAuthorizationCode({
  clientId,
  code,
  codeVerifier,
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: TRAQ_REDIRECT_URI,
  });
  const response = await fetch(new URL("oauth2/token", TRAQ_API_BASE), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`traQ token exchange failed (${response.status}).`);
  }
  const token = await response.json();
  const stored = {
    clientId,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    tokenType: token.token_type ?? "Bearer",
    scope: token.scope ?? TRAQ_OAUTH_SCOPES.join(" "),
    expiresAt: Date.now() + Number(token.expires_in ?? 0) * 1000,
    createdAt: new Date().toISOString(),
  };
  await writeTokenStore(stored);
  return stored;
}
