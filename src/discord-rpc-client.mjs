import {
  DISCORD_OAUTH_TOKEN_URL,
  DISCORD_RPC_REDIRECT_URI,
  DISCORD_RPC_SCOPES,
  readDiscordRpcCredentialStore,
  writeDiscordRpcCredentialStore,
} from "./discord-rpc-config.mjs";
import { DiscordRpcTransport } from "./discord-rpc-transport.mjs";

const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const TEXT_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12, 15, 16]);

function normalizeSearch(value) {
  return value.trim().toLocaleLowerCase("ja");
}

function channelName(channel) {
  return channel.name ?? channel.id;
}

export function buildDiscordRpcChannelPaths(channels) {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  return new Map(
    channels.map((channel) => {
      const parent = channel.parent_id
        ? byId.get(channel.parent_id)
        : undefined;
      return [
        channel.id,
        parent?.name
          ? `${channelName(parent)}/${channelName(channel)}`
          : channelName(channel),
      ];
    }),
  );
}

function messageLink(message, channel) {
  const guildPart = channel.guild_id ?? "@me";
  return `https://discord.com/channels/${guildPart}/${channel.id}/${message.id}`;
}

export function normalizeDiscordRpcMessages(channel, messages = []) {
  return messages.map((message) => ({
    ...message,
    guild_id: channel.guild_id ?? null,
    channel_id: channel.id,
    channel_name: channel.name ?? null,
    discord_link: messageLink(message, channel),
  }));
}

function tokenIsFresh(credential, now = Date.now()) {
  if (!credential.accessToken || !credential.expiresAt) return false;
  const expiresAt = Date.parse(credential.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now + TOKEN_EXPIRY_SKEW_MS;
}

async function oauthTokenRequest(body, fetchImpl) {
  const response = await fetchImpl(DISCORD_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      payload.error_description ?? payload.message ?? payload.error ?? "";
    throw new Error(
      `Discord OAuth token exchange failed (${response.status})${
        detail ? `: ${String(detail).slice(0, 300)}` : ""
      }`,
    );
  }
  if (!payload.access_token || !payload.expires_in) {
    throw new Error("Discord OAuth did not return a usable access token.");
  }
  return payload;
}

function mergeToken(credential, token, now = Date.now()) {
  return {
    ...credential,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? credential.refreshToken,
    tokenType: token.token_type ?? "Bearer",
    scope: token.scope ?? credential.scope,
    expiresAt: new Date(now + Number(token.expires_in) * 1000).toISOString(),
    authorizedAt: credential.authorizedAt ?? new Date(now).toISOString(),
    refreshedAt: new Date(now).toISOString(),
  };
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(values.length, 1)) },
      worker,
    ),
  );
  return results;
}

export class DiscordRpcClient {
  constructor({
    transportFactory = () => new DiscordRpcTransport(),
    fetchImpl = fetch,
    credentialReader = readDiscordRpcCredentialStore,
    credentialWriter = writeDiscordRpcCredentialStore,
    now = () => Date.now(),
  } = {}) {
    this.transportFactory = transportFactory;
    this.fetchImpl = fetchImpl;
    this.credentialReader = credentialReader;
    this.credentialWriter = credentialWriter;
    this.now = now;
    this.transport = undefined;
    this.credential = undefined;
    this.session = undefined;
    this.ready = undefined;
    this.connectPromise = undefined;
  }

  async connect(options = {}) {
    if (this.session && this.transport?.connected) return this.session;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.#connect(options);
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  async #connect({ allowInteractiveAuthorization = false } = {}) {
    const credential = await this.credentialReader();
    const transport = this.transportFactory();
    const ready = await transport.connect(credential.applicationId);
    this.transport = transport;
    this.ready = ready;
    let session;
    let nextCredential = credential;

    if (tokenIsFresh(credential, this.now())) {
      session = await transport
        .authenticate(credential.accessToken)
        .catch(() => undefined);
    }

    if (!session && credential.refreshToken) {
      try {
        const token = await oauthTokenRequest(
          {
            client_id: credential.applicationId,
            client_secret: credential.clientSecret,
            grant_type: "refresh_token",
            refresh_token: credential.refreshToken,
          },
          this.fetchImpl,
        );
        nextCredential = mergeToken(credential, token, this.now());
        session = await transport.authenticate(nextCredential.accessToken);
        await this.credentialWriter(nextCredential);
      } catch (error) {
        if (!allowInteractiveAuthorization) throw error;
      }
    }

    if (!session && allowInteractiveAuthorization) {
      const { code } = await transport.authorize({
        applicationId: credential.applicationId,
        scopes: DISCORD_RPC_SCOPES,
      });
      if (!code) {
        throw new Error("Discord RPC authorization did not return a code.");
      }
      const token = await oauthTokenRequest(
        {
          client_id: credential.applicationId,
          client_secret: credential.clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: credential.redirectUri ?? DISCORD_RPC_REDIRECT_URI,
        },
        this.fetchImpl,
      );
      nextCredential = mergeToken(
        {
          ...credential,
          authorizedAt: new Date(this.now()).toISOString(),
        },
        token,
        this.now(),
      );
      session = await transport.authenticate(nextCredential.accessToken);
      await this.credentialWriter(nextCredential);
    }

    if (!session) {
      throw new Error(
        "Discord RPC OAuth is not authorized. Run the Discord RPC authorization helper.",
      );
    }

    const scopes = new Set(session.scopes ?? []);
    const missing = DISCORD_RPC_SCOPES.filter((scope) => !scopes.has(scope));
    if (missing.length) {
      throw new Error(
        `Discord RPC authorization is missing required scopes: ${missing.join(", ")}`,
      );
    }

    this.credential = nextCredential;
    this.session = session;
    return session;
  }

  async authorize() {
    return this.connect({ allowInteractiveAuthorization: true });
  }

  async close() {
    if (this.connectPromise) {
      await this.connectPromise.catch(() => undefined);
    }
    await this.transport?.close();
    this.transport = undefined;
    this.session = undefined;
  }

  async request(command, args = {}) {
    await this.connect();
    return this.transport.request(command, args);
  }

  async whoami() {
    const session = await this.connect();
    return {
      user: session.user,
      application: session.application
        ? {
            id: session.application.id,
            name: session.application.name,
            description: session.application.description,
          }
        : undefined,
      scopes: session.scopes,
      expires: session.expires,
      desktopUser: this.ready?.user
        ? {
            id: this.ready.user.id,
            username: this.ready.user.username,
            globalName: this.ready.user.global_name,
          }
        : undefined,
    };
  }

  async listGuilds() {
    const result = await this.request("GET_GUILDS", {});
    return result.guilds ?? [];
  }

  getGuild(guildId) {
    return this.request("GET_GUILD", { guild_id: guildId });
  }

  async listChannels(guildId) {
    const result = await this.request("GET_CHANNELS", { guild_id: guildId });
    const channels = result.channels ?? [];
    const paths = buildDiscordRpcChannelPaths(channels);
    return channels.map((channel) => ({
      ...channel,
      path: paths.get(channel.id),
    }));
  }

  async getChannel(channelId, { includeMessages = false } = {}) {
    const channel = await this.request("GET_CHANNEL", {
      channel_id: channelId,
    });
    if (includeMessages) {
      return {
        ...channel,
        messages: normalizeDiscordRpcMessages(channel, channel.messages),
      };
    }
    const { messages, ...metadata } = channel;
    return {
      ...metadata,
      available_message_count: Array.isArray(messages)
        ? messages.length
        : undefined,
    };
  }

  async getChannelMessages(channelId, { limit = 50 } = {}) {
    const channel = await this.request("GET_CHANNEL", {
      channel_id: channelId,
    });
    const messages = normalizeDiscordRpcMessages(channel, channel.messages)
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, limit);
    return {
      channel: {
        id: channel.id,
        guild_id: channel.guild_id ?? null,
        name: channel.name ?? null,
        type: channel.type,
      },
      available_message_count: Array.isArray(channel.messages)
        ? channel.messages.length
        : 0,
      messages,
    };
  }

  async resolveChannel(query, { guildId, limit = 20 } = {}) {
    const normalized = normalizeSearch(query);
    const guilds = guildId ? [{ id: guildId }] : await this.listGuilds();
    const channelSets = await mapWithConcurrency(guilds, 4, async (guild) => ({
      guild,
      channels: await this.listChannels(guild.id),
    }));
    return channelSets
      .flatMap(({ guild, channels }) =>
        channels.map((channel) => ({
          ...channel,
          guild: {
            id: guild.id,
            name: guild.name ?? null,
          },
        })),
      )
      .filter((channel) =>
        normalizeSearch(
          `${channel.guild.name ?? ""}/${channel.path ?? channel.name ?? ""}`,
        ).includes(normalized),
      )
      .slice(0, limit);
  }

  async getRecentOwnMessages({
    guildId,
    channelQuery,
    maxChannels = 20,
    perChannelLimit = 50,
    limit = 50,
  }) {
    const session = await this.connect();
    const normalizedQuery = channelQuery
      ? normalizeSearch(channelQuery)
      : undefined;
    const channels = (await this.listChannels(guildId))
      .filter((channel) => TEXT_CHANNEL_TYPES.has(channel.type))
      .filter(
        (channel) =>
          !normalizedQuery ||
          normalizeSearch(channel.path ?? channel.name ?? "").includes(
            normalizedQuery,
          ),
      )
      .slice(0, maxChannels);

    const scanned = await mapWithConcurrency(channels, 4, async (channel) => {
      const result = await this.getChannelMessages(channel.id, {
        limit: perChannelLimit,
      });
      return {
        channel,
        messages: result.messages.filter(
          (message) => message.author?.id === session.user?.id,
        ),
      };
    });
    const messages = scanned
      .flatMap(({ messages }) => messages)
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, limit);
    return {
      guild_id: guildId,
      scanned_channel_count: channels.length,
      matched_message_count: messages.length,
      messages,
    };
  }
}
