import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiscordRpcChannelPaths,
  DiscordRpcClient,
  normalizeDiscordRpcMessages,
} from "../src/discord-rpc-client.mjs";
import {
  DISCORD_RPC_OPCODES,
  DiscordRpcFrameDecoder,
  encodeDiscordRpcFrame,
} from "../src/discord-rpc-transport.mjs";

test("Discord RPC frames decode across fragmented input", () => {
  const encoded = encodeDiscordRpcFrame(DISCORD_RPC_OPCODES.FRAME, {
    cmd: "GET_GUILDS",
    data: { guilds: [] },
  });
  const decoder = new DiscordRpcFrameDecoder();
  assert.deepEqual(decoder.push(encoded.subarray(0, 5)), []);
  assert.deepEqual(decoder.push(encoded.subarray(5)), [
    {
      opcode: DISCORD_RPC_OPCODES.FRAME,
      data: { cmd: "GET_GUILDS", data: { guilds: [] } },
    },
  ]);
});

test("Discord RPC channel paths include category names", () => {
  const channels = [
    { id: "1", type: 4, name: "projects" },
    { id: "2", type: 0, name: "general", parent_id: "1" },
  ];
  const paths = buildDiscordRpcChannelPaths(channels);
  assert.equal(paths.get("1"), "projects");
  assert.equal(paths.get("2"), "projects/general");
});

test("Discord RPC messages include stable Discord links", () => {
  const messages = normalizeDiscordRpcMessages(
    { id: "20", guild_id: "10", name: "general" },
    [{ id: "30", content: "hello" }],
  );
  assert.equal(
    messages[0].discord_link,
    "https://discord.com/channels/10/20/30",
  );
  assert.equal(messages[0].channel_name, "general");
});

test("Discord RPC client reads recent own messages through an authenticated user session", async () => {
  const requests = [];
  const transport = {
    connected: false,
    async connect() {
      this.connected = true;
      return {
        user: {
          id: "11111111111111111",
          username: "example-user",
          global_name: "Example User",
        },
      };
    },
    async authenticate() {
      return {
        user: { id: "11111111111111111", username: "example-user" },
        application: {
          id: "22222222222222222",
          name: "personal-context-hub Reader",
        },
        scopes: ["rpc", "identify", "messages.read"],
      };
    },
    async request(command, args) {
      requests.push({ command, args });
      if (command === "GET_CHANNELS") {
        return {
          channels: [
            { id: "33333333333333333", type: 0, name: "general" },
            { id: "44444444444444444", type: 2, name: "voice" },
          ],
        };
      }
      if (command === "GET_CHANNEL") {
        return {
          id: args.channel_id,
          guild_id: "55555555555555555",
          type: 0,
          name: "general",
          messages: [
            {
              id: "66666666666666666",
              content: "own",
              timestamp: "2026-07-23T00:00:00.000Z",
              author: { id: "11111111111111111" },
            },
            {
              id: "77777777777777777",
              content: "other",
              timestamp: "2026-07-22T00:00:00.000Z",
              author: { id: "88888888888888888" },
            },
          ],
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    async close() {
      this.connected = false;
    },
  };
  const client = new DiscordRpcClient({
    transportFactory: () => transport,
    credentialReader: async () => ({
      applicationId: "22222222222222222",
      clientSecret: "not-a-real-client-secret-for-tests",
      accessToken: "not-a-real-access-token",
      expiresAt: "2026-07-24T00:00:00.000Z",
    }),
    credentialWriter: async () => undefined,
    now: () => Date.parse("2026-07-23T00:00:00.000Z"),
  });

  const result = await client.getRecentOwnMessages({
    guildId: "55555555555555555",
  });
  assert.equal(result.scanned_channel_count, 1);
  assert.equal(result.matched_message_count, 1);
  assert.equal(result.messages[0].content, "own");
  assert.deepEqual(
    requests.map((request) => request.command),
    ["GET_CHANNELS", "GET_CHANNEL"],
  );
});

test("Discord RPC client shares one connection across concurrent first reads", async () => {
  let connectCount = 0;
  const transport = {
    connected: false,
    async connect() {
      connectCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.connected = true;
      return { user: { id: "11111111111111111" } };
    },
    async authenticate() {
      return {
        user: { id: "11111111111111111", username: "example-user" },
        application: {
          id: "22222222222222222",
          name: "personal-context-hub Reader",
        },
        scopes: ["rpc", "identify", "messages.read"],
      };
    },
    async request(command) {
      if (command === "GET_GUILDS") return { guilds: [] };
      throw new Error(`Unexpected command: ${command}`);
    },
    async close() {
      this.connected = false;
    },
  };
  const client = new DiscordRpcClient({
    transportFactory: () => transport,
    credentialReader: async () => ({
      applicationId: "22222222222222222",
      clientSecret: "not-a-real-client-secret-for-tests",
      accessToken: "not-a-real-access-token",
      expiresAt: "2026-07-24T00:00:00.000Z",
    }),
    credentialWriter: async () => undefined,
    now: () => Date.parse("2026-07-23T00:00:00.000Z"),
  });

  const [profile, guilds] = await Promise.all([
    client.whoami(),
    client.listGuilds(),
  ]);
  assert.equal(profile.user.username, "example-user");
  assert.deepEqual(guilds, []);
  assert.equal(connectCount, 1);
});
