import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readTokenStore,
  writeTokenStore,
} from "../src/integrations/traq/config.mjs";
import {
  readDiscordTokenStore,
  writeDiscordTokenStore,
} from "../src/integrations/discord-bot/config.mjs";
import {
  readDiscordRpcCredentialStore,
  writeDiscordRpcCredentialStore,
} from "../src/integrations/discord-rpc/config.mjs";

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
  assert.deepEqual(await readDiscordRpcCredentialStore(path), credential);
});

test("each integration preserves missing-file guidance and JSON parse failures", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "missing.json");
  for (const [read, message] of [
    [readTokenStore, /traQ is not authenticated/],
    [readDiscordTokenStore, /Discord is not authenticated/],
    [readDiscordRpcCredentialStore, /Discord RPC is not configured/],
  ]) {
    await assert.rejects(read(path), message);
  }
  await writeFile(path, "invalid JSON", { mode: 0o600 });
  for (const read of [
    readTokenStore,
    readDiscordTokenStore,
    readDiscordRpcCredentialStore,
  ]) {
    await assert.rejects(read(path), SyntaxError);
  }
});

test(
  "Windows DPAPI round-trips remain isolated and file overrides take precedence",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await temporaryDirectory(t);
    const environment = {
      PERSONAL_CONTEXT_DPAPI_DIR: directory,
      PERSONAL_CONTEXT_TOKEN_BACKEND: "dpapi",
      PERSONAL_CONTEXT_DISCORD_TOKEN_BACKEND: "dpapi",
      PERSONAL_CONTEXT_DISCORD_RPC_BACKEND: "dpapi",
      PERSONAL_CONTEXT_TOKEN_PATH: "",
      PERSONAL_CONTEXT_DISCORD_TOKEN_PATH: "",
      PERSONAL_CONTEXT_DISCORD_RPC_PATH: "",
    };
    const previous = Object.fromEntries(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    );
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    Object.assign(process.env, environment);
    const stores = [
      {
        file: "traq-oauth.dpapi",
        pathVariable: "PERSONAL_CONTEXT_TOKEN_PATH",
        read: readTokenStore,
        write: writeTokenStore,
        credential: {
          clientId: "test-client",
          accessToken: "test-access-token",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
      {
        file: "discord-bot.dpapi",
        pathVariable: "PERSONAL_CONTEXT_DISCORD_TOKEN_PATH",
        read: readDiscordTokenStore,
        write: writeDiscordTokenStore,
        credential: {
          token: "test.bot.token",
          applicationId: "123456789012345678",
          botUserId: "234567890123456789",
        },
      },
      {
        file: "discord-rpc.dpapi",
        pathVariable: "PERSONAL_CONTEXT_DISCORD_RPC_PATH",
        read: readDiscordRpcCredentialStore,
        write: writeDiscordRpcCredentialStore,
        credential: {
          applicationId: "123456789012345678",
          clientSecret: "test-client-secret-value-1234",
        },
      },
    ];
    for (const store of stores) await store.write(store.credential);
    for (const store of stores) {
      assert.deepEqual(await store.read(), store.credential);
      const protectedPath = join(directory, store.file);
      const encrypted = await readFile(protectedPath);
      assert.ok(
        !encrypted.includes(
          Buffer.from(`${JSON.stringify(store.credential, null, 2)}\n`),
        ),
      );

      const override = { ...store.credential, fixtureRevision: 2 };
      const explicitPath = join(directory, `${store.file}.json`);
      await store.write(override, explicitPath);
      assert.deepEqual(await store.read(explicitPath), override);
      assert.equal(
        await readFile(explicitPath, "utf8"),
        `${JSON.stringify(override, null, 2)}\n`,
      );

      const configuredPath = join(directory, `${store.file}-configured.json`);
      process.env[store.pathVariable] = configuredPath;
      await store.write(override);
      assert.deepEqual(await store.read(), override);
      assert.equal(
        await readFile(configuredPath, "utf8"),
        `${JSON.stringify(override, null, 2)}\n`,
      );
      process.env[store.pathVariable] = "";
      assert.deepEqual(await readFile(protectedPath), encrypted);
      assert.deepEqual(await store.read(), store.credential);
    }
  },
);
