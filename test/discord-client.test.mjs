import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiscordChannelPaths,
  buildDiscordMessagePayload,
  buildDiscordSearchParams,
  DiscordClient,
  encodeDiscordEmoji,
} from "../src/discord-client.mjs";

test("buildDiscordSearchParams preserves repeated official search filters", () => {
  const params = buildDiscordSearchParams({
    content: "ISUCON",
    channelIds: ["11111111111111111", "22222222222222222"],
    authorIds: ["33333333333333333"],
    has: ["link", "file"],
    includeNsfw: false,
    limit: 25,
    offset: 0,
    sortBy: "timestamp",
    sortOrder: "desc",
  });
  assert.equal(params.get("content"), "ISUCON");
  assert.deepEqual(params.getAll("channel_id"), [
    "11111111111111111",
    "22222222222222222",
  ]);
  assert.deepEqual(params.getAll("author_id"), ["33333333333333333"]);
  assert.deepEqual(params.getAll("has"), ["link", "file"]);
  assert.equal(params.get("include_nsfw"), "false");
});

test("buildDiscordChannelPaths includes category names", () => {
  const paths = buildDiscordChannelPaths([
    { id: "1", name: "projects", type: 4, parent_id: null },
    { id: "2", name: "isucon", type: 0, parent_id: "1" },
  ]);
  assert.equal(paths.get("1"), "projects");
  assert.equal(paths.get("2"), "projects/isucon");
});

test("message payload suppresses mentions unless explicitly allowed", () => {
  const safe = buildDiscordMessagePayload({ content: "@everyone <@123>" });
  assert.deepEqual(safe.allowed_mentions, {
    parse: [],
    replied_user: false,
  });

  const explicit = buildDiscordMessagePayload({
    content: "<@11111111111111111>",
    allowedUserIds: ["11111111111111111"],
    allowEveryone: false,
  });
  assert.deepEqual(explicit.allowed_mentions.users, ["11111111111111111"]);
  assert.deepEqual(explicit.allowed_mentions.parse, []);
});

test("encodeDiscordEmoji accepts Unicode and custom emoji without path escapes", () => {
  assert.equal(encodeDiscordEmoji("👍"), "%F0%9F%91%8D");
  assert.equal(
    encodeDiscordEmoji("pichu:123456789012345678"),
    "pichu%3A123456789012345678",
  );
  assert.throws(() => encodeDiscordEmoji("../escape"));
});

test("Discord request stays on API v10 and authenticates as a Bot", async () => {
  let captured;
  const client = new DiscordClient({
    fetchImpl: async (url, options) => {
      captured = { url: url.toString(), options };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ id: "11111111111111111", bot: true }),
      };
    },
  });
  client.getCredential = async () => ({ token: "test-bot-token" });
  const me = await client.whoami();
  assert.equal(captured.url, "https://discord.com/api/v10/users/@me");
  assert.equal(captured.options.headers.authorization, "Bot test-bot-token");
  assert.equal(me.bot, true);
});

test("pinMessage uses the current messages pins route", async () => {
  let captured;
  const client = new DiscordClient({
    fetchImpl: async (url, options) => {
      captured = { url: url.toString(), options };
      return { ok: true, status: 204, statusText: "No Content" };
    },
  });
  client.getCredential = async () => ({ token: "test-bot-token" });
  await client.pinMessage("11111111111111111", "22222222222222222");
  assert.equal(
    captured.url,
    "https://discord.com/api/v10/channels/11111111111111111/messages/pins/22222222222222222",
  );
  assert.equal(captured.options.method, "PUT");
});
