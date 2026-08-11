import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readTokenStore, writeTokenStore } from "../src/config.mjs";
import {
  readDiscordTokenStore,
  writeDiscordTokenStore,
} from "../src/discord-config.mjs";
import {
  readDiscordRpcCredentialStore,
  writeDiscordRpcCredentialStore,
} from "../src/discord-rpc-config.mjs";

async function temporaryDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), "personal-context-hub-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function assertPrivateFile(path) {
  if (process.platform === "win32") return;
  const metadata = await stat(path);
  assert.equal(metadata.mode & 0o777, 0o600);
}

test("traQ file fallback round-trips with private permissions", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "traq.json");
  const token = {
    clientId: "test-client",
    accessToken: "test-access-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  await writeTokenStore(token, path);
  assert.deepEqual(await readTokenStore(path), token);
  await assertPrivateFile(path);
});

test("Discord Bot file fallback round-trips with private permissions", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "discord-bot.json");
  const credential = {
    token: "test.bot.token",
    applicationId: "123456789012345678",
    botUserId: "234567890123456789",
  };

  await writeDiscordTokenStore(credential, path);
  assert.deepEqual(await readDiscordTokenStore(path), credential);
  await assertPrivateFile(path);
});

test("Discord RPC file fallback validates and round-trips privately", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "discord-rpc.json");
  const credential = {
    applicationId: "123456789012345678",
    clientSecret: "test-client-secret-value-1234",
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  await writeDiscordRpcCredentialStore(credential, path);
  assert.deepEqual(await readDiscordRpcCredentialStore(path), credential);
  await assertPrivateFile(path);

  await assert.rejects(
    writeDiscordRpcCredentialStore(
      { ...credential, clientSecret: "too-short" },
      path,
    ),
    /invalid Client Secret/,
  );
});
