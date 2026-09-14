import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "../src/bootstrap/client.js";
import { readAccount } from "../src/auth/account.js";
import {
  isSelf,
  participantGroups,
  previousRegistration,
} from "../src/ui/participant-identity.js";

test("same data directory preserves identity across browser/desktop restarts and drains ordered saves", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-identity-"));
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  const start = async (desktop = false) => {
    const client = new Client(directory);
    t.mock.method(client, "checkAccount", async () => {});
    if (desktop)
      client.desktop = {
        name: "Test desktop",
        version: "test",
        pid: 1,
        platform: "test",
      };
    clients.push(client);
    await client.start(0);
    return client;
  };
  const first = await start();
  assert.equal(first.identityStatus, "created");
  const key = await first.credentials.get("device.privateKey");
  const publicKey = first.settings.publicKey;
  first.settings.deviceId = "saved-device";
  first.settings.profile = {
    name: "Before",
    context: "Saved context",
    avatar: "data:image/png;base64,YQ==",
  };
  const before = first.save();
  first.settings.profile.name = "After";
  const after = first.save();
  await first.close();
  await Promise.all([before, after]);
  const second = await start(true);
  assert.equal(second.identityStatus, "restored");
  assert.equal(second.settings.deviceId, "saved-device");
  assert.equal(second.settings.profile?.name, "After");
  assert.equal(second.settings.publicKey, publicKey);
  assert.equal(await second.credentials.get("device.privateKey"), key);
  assert.equal(second.allow, false);
  const state = await (await fetch(second.origin + "/api/state")).text();
  assert.ok(!state.includes(key!));
  assert.ok(state.includes('"status":"restored"'));
  await second.close();
  const third = await start();
  assert.equal(third.settings.deviceId, "saved-device");
});

test("missing public key is recovered; missing, mismatched and corrupt secrets never create a new identity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-keys-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = new Client(directory);
  t.mock.method(initial, "checkAccount", async () => {});
  await initial.start(0);
  const publicKey = initial.settings.publicKey;
  delete initial.settings.publicKey;
  await initial.save();
  await initial.close();
  const recovered = new Client(directory);
  t.mock.method(recovered, "checkAccount", async () => {});
  await recovered.start(0);
  assert.equal(recovered.identityStatus, "public key recovered");
  assert.equal(recovered.settings.publicKey, publicKey);
  await recovered.close();
  const other = generateKeyPairSync("ed25519");
  await recovered.credentials.set(
    "device.privateKey",
    other.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  );
  await assert.rejects(new Client(directory).start(0), /DEVICE_KEY_MISMATCH/);
  await recovered.credentials.set("device.privateKey", "");
  await assert.rejects(
    new Client(directory).start(0),
    /DEVICE_KEY_UNAVAILABLE/,
  );
  await writeFile(join(directory, "secrets.json"), "{broken");
  await assert.rejects(new Client(directory).start(0), SyntaxError);
  assert.equal(
    JSON.parse(await readFile(join(directory, "client.json"), "utf8"))
      .publicKey,
    publicKey,
  );
});

test("failed saves are reported on shutdown and a later successful snapshot can recover", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-save-failure-"));
  const client = new Client(directory);
  t.mock.method(client, "checkAccount", async () => {});
  await client.start(0);
  t.after(async () => {
    await client.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  await rm(join(directory, "client.json"));
  await mkdir(join(directory, "client.json"));
  await assert.rejects(client.save());
  await assert.rejects(client.close());
  await rm(join(directory, "client.json"), { recursive: true });
  await client.save();
  await client.close();
});

test("Codex account projection strips secrets, supports signed-out and API-key states, and closes on failure/timeout", async () => {
  for (const [input, expected] of [
    [
      {
        account: {
          type: "chatgpt",
          email: "example@example.invalid",
          accessToken: "SECRET",
        },
      },
      {
        status: "available",
        type: "chatgpt",
        email: "example@example.invalid",
      },
    ],
    [
      { account: { type: "apiKey", apiKey: "SECRET", email: "SECRET" } },
      { status: "available", type: "apiKey" },
    ],
    [
      { account: { type: "chatgpt", email: null } },
      { status: "available", type: "chatgpt" },
    ],
    [{ account: null }, { status: "signed-out" }],
    [{ error: "SECRET" }, { status: "unavailable" }],
  ]) {
    let closed = false;
    const result = await readAccount("unused", () => ({
      request: async (method, params) => {
        assert.equal(method, "account/read");
        assert.deepEqual(params, { refreshToken: false });
        return input;
      },
      close: async () => {
        closed = true;
      },
    }));
    assert.deepEqual(result, expected);
    assert.equal(closed, true);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  }
  for (const request of [
    async () => {
      throw new Error("SECRET");
    },
    () => new Promise(() => {}),
  ]) {
    let closed = false;
    assert.deepEqual(
      await readAccount(
        "unused",
        () => ({
          request,
          close: async () => {
            closed = true;
          },
        }),
        10,
      ),
      { status: "unavailable" },
    );
    assert.equal(closed, true);
  }
});

test("presentation groups only matching identities and retains original device IDs", () => {
  const people = [
    { id: "old", identityId: "same", name: "Me" },
    { id: "current", identityId: "same", name: "Me" },
    { id: "other", identityId: "different", name: "Me" },
  ];
  const before = structuredClone(people);
  assert.deepEqual(
    participantGroups(people).map((group) => group.map((p) => p.id)),
    [["old", "current"], ["other"]],
  );
  assert.ok(isSelf(people[0], { deviceId: "current", identityId: "same" }));
  assert.ok(!isSelf(people[2], { deviceId: "current", identityId: "same" }));
  assert.deepEqual(people, before);
  assert.ok(
    previousRegistration(
      { clientId: "old", clientIdentityId: "same" },
      { deviceId: "current", identityId: "same" },
    ),
  );
  assert.ok(
    !previousRegistration(
      { clientId: "old" },
      { deviceId: "current", identityId: "same" },
    ),
  );
  assert.ok(
    !previousRegistration(
      { clientId: "current", clientIdentityId: "same" },
      { deviceId: "current", identityId: "same" },
    ),
  );
});

test("expired pending pairing is cleared on restart without rotating the device key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-expired-pair-"));
  const first = new Client(directory);
  t.mock.method(first, "checkAccount", async () => {});
  await first.start(0);
  first.settings.pendingPair = {
    id: "expired",
    engineUrl: "https://example.invalid",
    expires: Date.now() - 1,
  };
  await first.credentials.set("pair.expired", "SYNTHETIC_PROOF");
  await first.save();
  await first.close();
  const second = new Client(directory);
  t.mock.method(second, "checkAccount", async () => {});
  t.after(async () => {
    await second.close();
    await rm(directory, { recursive: true, force: true });
  });
  await second.start(0);
  assert.equal(second.settings.publicKey, first.settings.publicKey);
  assert.equal(second.settings.pendingPair, undefined);
  assert.ok(!(await second.credentials.get("pair.expired")));
  assert.equal(second.status, "pairing expired");
});
