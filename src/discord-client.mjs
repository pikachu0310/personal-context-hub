import { setTimeout as delay } from "node:timers/promises";
import { DISCORD_API_BASE, readDiscordTokenStore } from "./discord-config.mjs";

const TOKEN_CACHE_MS = 60 * 1000;
const DIRECTORY_CACHE_MS = 5 * 60 * 1000;
const SUPPRESS_NOTIFICATIONS = 1 << 12;

const CHANNEL_TYPES = new Map([
  [0, "text"],
  [1, "dm"],
  [2, "voice"],
  [3, "group_dm"],
  [4, "category"],
  [5, "announcement"],
  [10, "announcement_thread"],
  [11, "public_thread"],
  [12, "private_thread"],
  [13, "stage_voice"],
  [14, "directory"],
  [15, "forum"],
  [16, "media"],
]);

function appendMany(params, key, values = []) {
  for (const value of values) params.append(key, String(value));
}

export function buildDiscordSearchParams(input) {
  const params = new URLSearchParams();
  for (const [key, value] of [
    ["limit", input.limit],
    ["offset", input.offset],
    ["max_id", input.maxId],
    ["min_id", input.minId],
    ["slop", input.slop],
    ["content", input.content],
    ["mention_everyone", input.mentionEveryone],
    ["pinned", input.pinned],
    ["sort_by", input.sortBy],
    ["sort_order", input.sortOrder],
    ["include_nsfw", input.includeNsfw],
  ]) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  appendMany(params, "channel_id", input.channelIds);
  appendMany(params, "author_type", input.authorTypes);
  appendMany(params, "author_id", input.authorIds);
  appendMany(params, "mentions", input.mentionedUserIds);
  appendMany(params, "mentions_role_id", input.mentionedRoleIds);
  appendMany(params, "replied_to_user_id", input.repliedToUserIds);
  appendMany(params, "has", input.has);
  appendMany(params, "link_hostname", input.linkHostnames);
  appendMany(params, "attachment_extension", input.attachmentExtensions);
  return params;
}

export function buildDiscordChannelPaths(channels) {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  return new Map(
    channels.map((channel) => {
      const parent = channel.parent_id
        ? byId.get(channel.parent_id)
        : undefined;
      const name = channel.name ?? channel.id;
      return [channel.id, parent?.name ? `${parent.name}/${name}` : name];
    }),
  );
}

export function encodeDiscordEmoji(emoji) {
  const value = emoji.trim();
  if (!value || value.length > 100 || /[/?#\\]/.test(value)) {
    throw new Error("Use one Unicode emoji or a custom emoji in name:id form.");
  }
  return encodeURIComponent(value);
}

function allowedMentions({
  allowedUserIds = [],
  allowedRoleIds = [],
  allowEveryone = false,
} = {}) {
  const value = {
    parse: allowEveryone ? ["everyone"] : [],
    replied_user: false,
  };
  if (allowedUserIds.length) value.users = allowedUserIds;
  if (allowedRoleIds.length) value.roles = allowedRoleIds;
  return value;
}

export function buildDiscordMessagePayload(input) {
  const payload = {
    content: input.content,
    allowed_mentions: allowedMentions(input),
  };
  if (input.nonce) {
    payload.nonce = input.nonce;
    payload.enforce_nonce = true;
  }
  if (input.replyToMessageId) {
    payload.message_reference = {
      message_id: input.replyToMessageId,
      fail_if_not_exists: true,
    };
  }
  if (input.suppressNotifications) payload.flags = SUPPRESS_NOTIFICATIONS;
  return payload;
}

export class DiscordClient {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetchImpl = fetchImpl;
    this.tokenCache = undefined;
    this.directoryCache = new Map();
  }

  async getCredential({ force = false } = {}) {
    const now = Date.now();
    if (
      !force &&
      this.tokenCache &&
      this.tokenCache.loadedAt > now - TOKEN_CACHE_MS
    ) {
      return this.tokenCache.credential;
    }
    const credential = await readDiscordTokenStore();
    this.tokenCache = { credential, loadedAt: now };
    return credential;
  }

  async request(
    path,
    { method = "GET", searchParams, json, retryCount = 0 } = {},
  ) {
    const credential = await this.getCredential();
    const url = new URL(path.replace(/^\/+/, ""), DISCORD_API_BASE);
    if (searchParams) url.search = searchParams.toString();
    const headers = {
      accept: "application/json",
      authorization: `Bot ${credential.token}`,
      "user-agent": "DiscordBot (https://pichu.dev, 0.1.0)",
    };
    if (json !== undefined) headers["content-type"] = "application/json";

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });

    if (response.status === 429 && retryCount < 2) {
      const rateLimit = await response.json().catch(() => ({}));
      const waitMs = Math.min(
        Math.max(Number(rateLimit.retry_after ?? 1) * 1000, 250),
        5000,
      );
      await delay(waitMs);
      return this.request(path, {
        method,
        searchParams,
        json,
        retryCount: retryCount + 1,
      });
    }

    if (response.status === 401 && retryCount === 0) {
      this.tokenCache = undefined;
      const next = await this.getCredential({ force: true });
      if (next.token !== credential.token) {
        return this.request(path, {
          method,
          searchParams,
          json,
          retryCount: 1,
        });
      }
    }

    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      const message =
        typeof body?.message === "string" ? body.message.slice(0, 300) : "";
      const code = body?.code === undefined ? "" : ` code=${body.code}`;
      throw new Error(
        `Discord API ${response.status} ${response.statusText}${code}${message ? `: ${message}` : ""}`,
      );
    }
    if (response.status === 204) return undefined;
    return response.json();
  }

  whoami() {
    return this.request("users/@me");
  }

  listGuilds({ withCounts = true } = {}) {
    return this.request("users/@me/guilds", {
      searchParams: new URLSearchParams({
        limit: "200",
        with_counts: String(withCounts),
      }),
    });
  }

  getGuild(guildId) {
    return this.request(`guilds/${guildId}`, {
      searchParams: new URLSearchParams({ with_counts: "true" }),
    });
  }

  async listChannels(guildId, { includeThreads = true } = {}) {
    const channels = await this.request(`guilds/${guildId}/channels`);
    if (!includeThreads) return channels;
    const active = await this.request(`guilds/${guildId}/threads/active`);
    return [...channels, ...(active.threads ?? [])];
  }

  getChannel(channelId) {
    return this.request(`channels/${channelId}`);
  }

  getUser(userId) {
    return this.request(`users/${userId}`);
  }

  async getDirectory(guildId) {
    const cached = this.directoryCache.get(guildId);
    if (cached?.loadedAt > Date.now() - DIRECTORY_CACHE_MS) return cached;
    const [guild, channels] = await Promise.all([
      this.getGuild(guildId),
      this.listChannels(guildId),
    ]);
    const directory = {
      guild,
      channels,
      paths: buildDiscordChannelPaths(channels),
      loadedAt: Date.now(),
    };
    this.directoryCache.set(guildId, directory);
    return directory;
  }

  async resolveChannel(query, { guildId, limit = 20 } = {}) {
    const needle = query.trim().replace(/^#/, "").toLowerCase();
    const guilds = guildId
      ? [await this.getGuild(guildId)]
      : await this.listGuilds({ withCounts: false });
    const matches = [];
    for (const guild of guilds) {
      const directory = await this.getDirectory(guild.id);
      for (const channel of directory.channels) {
        const path =
          directory.paths.get(channel.id) ?? channel.name ?? channel.id;
        const qualified = `${guild.name}/${path}`;
        if (qualified.toLowerCase().includes(needle)) {
          matches.push({
            guildId: guild.id,
            guildName: guild.name,
            channelId: channel.id,
            channelName: channel.name,
            channelPath: qualified,
            channelType:
              CHANNEL_TYPES.get(channel.type) ?? `unknown_${channel.type}`,
            parentId: channel.parent_id ?? null,
          });
        }
      }
      if (matches.length >= limit) break;
    }
    return matches.slice(0, limit);
  }

  enrichMessage(message, directory) {
    const guildId = message.guild_id ?? directory?.guild?.id;
    const channelPath = directory?.paths.get(message.channel_id);
    return {
      ...message,
      guildName: directory?.guild?.name,
      channelPath: channelPath
        ? `${directory.guild.name}/${channelPath}`
        : undefined,
      jumpUrl: `https://discord.com/channels/${guildId ?? "@me"}/${message.channel_id}/${message.id}`,
    };
  }

  async getMessage(channelId, messageId) {
    const [channel, message] = await Promise.all([
      this.getChannel(channelId),
      this.request(`channels/${channelId}/messages/${messageId}`),
    ]);
    const directory = channel.guild_id
      ? await this.getDirectory(channel.guild_id)
      : undefined;
    return this.enrichMessage(message, directory);
  }

  async getChannelMessages(channelId, input = {}) {
    const positionals = [input.before, input.after, input.around].filter(
      Boolean,
    );
    if (positionals.length > 1) {
      throw new Error("Use only one of before, after, or around.");
    }
    const params = new URLSearchParams({ limit: String(input.limit ?? 50) });
    for (const [key, value] of [
      ["before", input.before],
      ["after", input.after],
      ["around", input.around],
    ]) {
      if (value) params.set(key, value);
    }
    const [channel, messages] = await Promise.all([
      this.getChannel(channelId),
      this.request(`channels/${channelId}/messages`, { searchParams: params }),
    ]);
    const directory = channel.guild_id
      ? await this.getDirectory(channel.guild_id)
      : undefined;
    return messages.map((message) => this.enrichMessage(message, directory));
  }

  async searchGuildMessages(guildId, input) {
    const filterKeys = [
      "content",
      "maxId",
      "minId",
      "channelIds",
      "authorTypes",
      "authorIds",
      "mentionedUserIds",
      "mentionedRoleIds",
      "repliedToUserIds",
      "mentionEveryone",
      "pinned",
      "has",
      "linkHostnames",
      "attachmentExtensions",
    ];
    const hasFilter = filterKeys.some((key) => {
      const value = input[key];
      return Array.isArray(value)
        ? value.length > 0
        : value !== undefined && value !== null && value !== "";
    });
    if (!hasFilter)
      throw new Error("Specify at least one Discord search filter.");
    const result = await this.request(`guilds/${guildId}/messages/search`, {
      searchParams: buildDiscordSearchParams(input),
    });
    if (result.code === 110000) {
      return {
        indexingPending: true,
        retryAfterSeconds: result.retry_after,
        documentsIndexed: result.documents_indexed,
        messages: [],
      };
    }
    const directory = await this.getDirectory(guildId);
    return {
      ...result,
      messages: (result.messages ?? []).map((group) =>
        (Array.isArray(group) ? group : [group]).map((message) =>
          this.enrichMessage(message, directory),
        ),
      ),
    };
  }

  async getChannelPins(channelId, { before, limit = 50 } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set("before", before);
    const pins = await this.request(`channels/${channelId}/messages/pins`, {
      searchParams: params,
    });
    const channel = await this.getChannel(channelId);
    const directory = channel.guild_id
      ? await this.getDirectory(channel.guild_id)
      : undefined;
    return {
      ...pins,
      items: (pins.items ?? []).map((item) => ({
        ...item,
        message: this.enrichMessage(item.message, directory),
      })),
    };
  }

  getReactions(channelId, messageId, emoji, { after, limit = 25 } = {}) {
    const params = new URLSearchParams({ limit: String(limit), type: "0" });
    if (after) params.set("after", after);
    return this.request(
      `channels/${channelId}/messages/${messageId}/reactions/${encodeDiscordEmoji(emoji)}`,
      { searchParams: params },
    );
  }

  async postMessage(channelId, input) {
    const message = await this.request(`channels/${channelId}/messages`, {
      method: "POST",
      json: buildDiscordMessagePayload(input),
    });
    const channel = await this.getChannel(channelId);
    const directory = channel.guild_id
      ? await this.getDirectory(channel.guild_id)
      : undefined;
    return this.enrichMessage(message, directory);
  }

  async postDirectMessage(userId, input) {
    const channel = await this.request("users/@me/channels", {
      method: "POST",
      json: { recipient_id: userId },
    });
    return this.postMessage(channel.id, input);
  }

  async editMessage(channelId, messageId, input) {
    const credential = await this.getCredential();
    const current = await this.request(
      `channels/${channelId}/messages/${messageId}`,
    );
    if (current.author?.id !== credential.botUserId) {
      throw new Error(
        "Discord only permits editing messages sent by this Bot.",
      );
    }
    const message = await this.request(
      `channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        json: {
          content: input.content,
          allowed_mentions: allowedMentions(input),
        },
      },
    );
    const channel = await this.getChannel(channelId);
    const directory = channel.guild_id
      ? await this.getDirectory(channel.guild_id)
      : undefined;
    return this.enrichMessage(message, directory);
  }

  async deleteMessage(
    channelId,
    messageId,
    { allowDeleteOtherAuthors = false } = {},
  ) {
    const [credential, current] = await Promise.all([
      this.getCredential(),
      this.request(`channels/${channelId}/messages/${messageId}`),
    ]);
    if (
      current.author?.id !== credential.botUserId &&
      !allowDeleteOtherAuthors
    ) {
      throw new Error(
        "Deleting another author's message requires allowDeleteOtherAuthors=true and explicit current-user confirmation.",
      );
    }
    await this.request(`channels/${channelId}/messages/${messageId}`, {
      method: "DELETE",
    });
    return { deleted: true, channelId, messageId };
  }

  async addReaction(channelId, messageId, emoji) {
    await this.request(
      `channels/${channelId}/messages/${messageId}/reactions/${encodeDiscordEmoji(emoji)}/@me`,
      { method: "PUT" },
    );
    return { added: true, channelId, messageId, emoji };
  }

  async removeReaction(channelId, messageId, emoji) {
    await this.request(
      `channels/${channelId}/messages/${messageId}/reactions/${encodeDiscordEmoji(emoji)}/@me`,
      { method: "DELETE" },
    );
    return { removed: true, channelId, messageId, emoji };
  }

  async pinMessage(channelId, messageId) {
    await this.request(`channels/${channelId}/messages/pins/${messageId}`, {
      method: "PUT",
    });
    return { pinned: true, channelId, messageId };
  }

  async unpinMessage(channelId, messageId) {
    await this.request(`channels/${channelId}/messages/pins/${messageId}`, {
      method: "DELETE",
    });
    return { pinned: false, channelId, messageId };
  }
}
