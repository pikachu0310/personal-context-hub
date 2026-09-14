import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Engine } from "../src/bootstrap/engine.js";
import { Client } from "../../client/src/bootstrap/client.js";
import { deviceIdentity } from "../src/clients/identity.js";
import {
  seedParticipants,
  taskParticipants,
} from "../src/processing/projects/task-participants.js";
import { ProjectTeam } from "../src/processing/projects/team.js";
import type { Device } from "../src/domain/models.js";
import type { Task } from "@ido/common/contracts/protocol";

async function until(check: () => boolean) {
  for (let i = 0; i < 240; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("CONDITION_TIMEOUT");
}
async function setup(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "ido-engine-identity-"));
  let engine = new Engine({
    directory: join(directory, "engine"),
    port: 0,
    previewPort: 0,
    conversation: false,
  });
  const user = engine.store.createUser(
    "admin",
    "synthetic-password-long",
    "admin",
  );
  const session = engine.store.session(user.id);
  await engine.listen();
  t.after(async () => {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  });
  const post = (path: string, input: unknown, authenticated = false) =>
    fetch(engine.origin + "/api/admin/" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated
          ? {
              cookie: `ido_session=${session.token}`,
              "x-csrf-token": session.csrf,
            }
          : {}),
      },
      body: JSON.stringify(input),
    });
  return {
    directory,
    get engine() {
      return engine;
    },
    user,
    session,
    post,
    async restart() {
      await engine.close();
      engine = new Engine({
        directory: join(directory, "engine"),
        port: 0,
        previewPort: 0,
        conversation: false,
      });
      await engine.listen();
    },
  };
}

test("pair result survives lost responses/Engine restart; re-pairing reuses ID, duplicate choice is explicit and revocation is respected", async (t) => {
  const s = await setup(t);
  const publicKey = generateKeyPairSync("ed25519")
    .publicKey.export({ format: "pem", type: "spki" })
    .toString();
  const request = async () =>
    (await (
      await s.post("pair/request", { name: "Same name", publicKey })
    ).json()) as any;
  const pair = await request();
  assert.equal(
    (await s.post("pair/approve", { id: pair.id }, true)).status,
    200,
  );
  const first = (await (await s.post("pair/poll", pair)).json()) as any;
  const device = s.engine.store.get<Device>("device", first.deviceId)!;
  const identity = deviceIdentity(s.engine.store, device);
  await s.restart();
  assert.deepEqual(await (await s.post("pair/poll", pair)).json(), first);
  assert.equal(deviceIdentity(s.engine.store, device), identity);
  const again = await request();
  assert.equal(
    (await s.post("pair/approve", { id: again.id }, true)).status,
    200,
  );
  assert.equal(
    ((await (await s.post("pair/poll", again)).json()) as any).deviceId,
    first.deviceId,
  );
  assert.equal(s.engine.store.list("device").length, 1);
  s.engine.store.put("device", "duplicate", { ...device, id: "duplicate" });
  const duplicate = await request();
  const candidates = (await (
    await fetch(s.engine.origin + "/api/admin/pair/" + duplicate.id, {
      headers: { cookie: `ido_session=${s.session.token}` },
    })
  ).json()) as any;
  assert.equal(candidates.candidates.length, 2);
  assert.equal(
    (await s.post("pair/approve", { id: duplicate.id }, true)).status,
    409,
  );
  assert.equal(
    (
      await s.post(
        "pair/approve",
        { id: duplicate.id, deviceId: "forged" },
        true,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await s.post(
        "pair/approve",
        { id: duplicate.id, deviceId: device.id },
        true,
      )
    ).status,
    200,
  );
  assert.equal(
    ((await (await s.post("pair/poll", duplicate)).json()) as any).deviceId,
    device.id,
  );
  s.engine.store.put("device", device.id, { ...device, revoked: true });
  assert.equal((await s.post("pair/poll", pair)).status, 410);
  assert.equal(
    (await s.post("pair/poll", { ...again, proof: "forged" })).status,
    410,
  );
  const expired = s.engine.store.get<any>("pair", again.id);
  expired.expires = Date.now() - 1;
  s.engine.store.put("pair", again.id, expired);
  assert.equal((await s.post("pair/poll", again)).status, 410);
});

test("same-key historical participants share presentation identity without changing permissions, tasks or different users/keys", async (t) => {
  const s = await setup(t);
  const publicKey = generateKeyPairSync("ed25519")
    .publicKey.export({ format: "pem", type: "spki" })
    .toString();
  const original: Device = {
    id: "old",
    userId: s.user.id,
    publicKey,
    name: "Same",
    revoked: false,
    generation: 0,
    grants: [],
    slots: 1,
    lastAssigned: 0,
  };
  const second = { ...original, id: "current" };
  s.engine.store.put("device", original.id, original);
  s.engine.store.put("device", second.id, second);
  const task = {
    id: "past",
    clientId: "old",
    authorId: "client-current",
    projectId: "default",
    controlReceipts: {},
    sourceStatements: [],
  } as unknown as Task;
  s.engine.store.put("task", task.id, task);
  const people = taskParticipants(s.engine.store, task);
  assert.equal(people.length, 2);
  assert.equal(new Set(people.map((p) => p.identityId)).size, 1);
  const membershipTask = structuredClone(task);
  seedParticipants(s.engine.store, membershipTask);
  assert.deepEqual(membershipTask.memberStates, { old: true, current: true });
  membershipTask.memberStates!.current = false;
  assert.deepEqual(
    taskParticipants(s.engine.store, membershipTask).map((p) => p.id),
    ["old"],
  );
  assert.equal(
    taskParticipants(s.engine.store, membershipTask)[0].identityId,
    people[0].identityId,
  );
  assert.equal(people[0].identityId, deviceIdentity(s.engine.store, second));
  assert.notEqual(
    people[0].identityId,
    deviceIdentity(s.engine.store, { ...second, userId: "another-user" }),
  );
  assert.notEqual(
    people[0].identityId,
    deviceIdentity(s.engine.store, {
      ...second,
      publicKey: generateKeyPairSync("ed25519")
        .publicKey.export({ format: "pem", type: "spki" })
        .toString(),
    }),
  );
  const team = new ProjectTeam(s.engine.store);
  team.join("old", "default");
  assert.throws(
    () => team.require("current", "default"),
    /PROJECT_INVITATION_REQUIRED/,
  );
  assert.deepEqual(s.engine.store.get("task", task.id), task);
  assert.deepEqual(s.engine.store.get("device", "old"), original);
  assert.deepEqual(s.engine.store.get("device", "current"), second);
  s.engine.store.put("device", "old", { ...original, revoked: true });
  assert.equal(
    taskParticipants(s.engine.store, task)[0].identityId,
    people[0].identityId,
  );
  assert.throws(
    () => team.require("old", "default"),
    /DEVICE_APPROVAL_REQUIRED/,
  );
});

test("Client resumes pending pairing after response loss and restart, preserving device and presentation identity", async (t) => {
  const s = await setup(t);
  const clients: Client[] = [];
  t.after(async () => {
    for (const c of clients) await c.close();
  });
  const start = async () => {
    const c = new Client(join(s.directory, "client"));
    t.mock.method(c, "checkAccount", async () => {});
    await c.start(0);
    clients.push(c);
    return c;
  };
  const first = await start();
  await first.pair(s.engine.origin);
  const pairId = first.pairing!.id;
  const fetchOriginal = globalThis.fetch;
  let dropped = false;
  t.mock.method(globalThis, "fetch", async (input: any, init?: any) => {
    const response = await fetchOriginal(input, init);
    if (String(input).endsWith("/pair/poll") && !dropped) {
      dropped = true;
      throw new Error("SIMULATED_RESPONSE_LOSS");
    }
    return response;
  });
  assert.equal(
    (await s.post("pair/approve", { id: pairId }, true)).status,
    200,
  );
  const registration = s.engine.store.get<any>("pair", pairId);
  await until(() => dropped);
  await first.close();
  const second = await start();
  second.account = {
    status: "available",
    type: "chatgpt",
    email: "private-account@example.invalid",
  };
  assert.equal(second.pairing?.id, pairId);
  const state = await (await fetch(second.origin + "/api/state")).text();
  assert.ok(!state.includes(second.pairing!.proof));
  await until(() => second.connected);
  assert.equal(second.settings.deviceId, registration.deviceId);
  assert.equal(s.engine.store.list("device").length, 1);
  assert.ok(
    !JSON.stringify(s.engine.store.list("device")).includes(
      "private-account@example.invalid",
    ),
  );
  const identity = second.settings.identityId;
  assert.ok(identity);
  await second.close();
  const third = await start();
  await until(() => third.connected);
  assert.equal(third.settings.deviceId, registration.deviceId);
  assert.equal(third.settings.identityId, identity);
});
