import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits as P } from "discord.js";
import { inspectSetup } from "../src/input/setup.js";
import { discordManifest } from "../src/manifest.js";
const all =
  P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.AttachFiles;
const payloads: Record<string, unknown> = {
  "/oauth2/applications/@me": { id: "app" },
  "/users/@me": { id: "bot" },
  "/guilds/1": { id: "1", roles: [{ id: "1", permissions: String(all) }] },
  "/guilds/1/members/bot": { roles: [] },
  "/guilds/1/channels": [
    { id: "allowed", name: "general", type: 0, permission_overwrites: [] },
    {
      id: "denied",
      name: "private",
      type: 0,
      permission_overwrites: [
        { id: "1", type: 0, allow: "0", deny: String(P.SendMessages) },
      ],
    },
  ],
};
const request: typeof fetch = async (url) =>
  new Response(
    JSON.stringify(
      payloads[String(url).replace("https://discord.com/api/v10", "")],
    ),
  );
test("minimal Bot setup derives Application ID and lists channels by effective permissions without OAuth", async () => {
  const result = await inspectSetup(
    { botToken: "placeholder", guildId: "1" },
    request,
  );
  assert.deepEqual(result, {
    appId: "app",
    channels: [{ id: "allowed", name: "general" }],
  });
  assert.equal(
    discordManifest.fields.find((f) => f.key === "clientSecret")?.required,
    undefined,
  );
  await assert.rejects(
    inspectSetup(
      { botToken: "placeholder", guildId: "1", textChannelId: "denied" },
      request,
    ),
    /DISCORD_CHANNEL_PERMISSION_REQUIRED/,
  );
  await assert.rejects(
    inspectSetup(
      { botToken: "placeholder", guildId: "1" },
      async () => new Response("", { status: 401 }),
    ),
    /DISCORD_TOKEN_INVALID/,
  );
  await assert.rejects(
    inspectSetup({ botToken: "placeholder", guildId: "1" }, async (url) =>
      String(url).includes("guilds")
        ? new Response("", { status: 403 })
        : request(url),
    ),
    /DISCORD_GUILD_ACCESS_REQUIRED/,
  );
});
