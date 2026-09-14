import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../src/bootstrap/client.js";

test("profile avatars persist, preserve on name edits, reject unsafe inputs and can be removed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-profile-"));
  const client = new Client(directory);
  client.credentials.backend = "file";
  t.mock.method(client, "checkAccount", async () => {});
  await client.start(0);
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  const post = (path: string, input: unknown) =>
    fetch(client.origin + "/api/" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": client.csrf,
      },
      body: JSON.stringify(input),
    });
  const avatar = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(
    (await post("profile", { name: "Demo", context: "", avatar })).status,
    200,
  );
  assert.equal(client.settings.profile?.avatar, avatar);
  assert.equal(
    JSON.parse(await readFile(join(directory, "client.json"), "utf8")).profile
      .avatar,
    avatar,
  );
  assert.equal((await post("profile", { name: "Renamed" })).status, 200);
  assert.equal(client.settings.profile?.avatar, avatar);
  for (const invalid of [
    "https://example.invalid/image.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64," + "A".repeat(4096),
  ]) {
    assert.ok(!(await post("profile", { name: "Demo", avatar: invalid })).ok);
    assert.equal(client.settings.profile?.avatar, avatar);
  }
  assert.equal(
    (await post("profile", { name: "Demo", avatar: "" })).status,
    200,
  );
  assert.equal(client.settings.profile?.avatar, undefined);
  assert.equal((await post("reconnect", {})).status, 409);
  client.settings.deviceId = "device";
  client.settings.engineUrl = "https://engine.example.invalid";
  client.settings.projects = [{ id: "project", name: "Project", remote: "" }];
  let connections = 0;
  t.mock.method(client, "connect", async () => {
    connections++;
    client.status = "connecting";
  });
  const before = structuredClone(client.settings);
  assert.equal((await post("reconnect", {})).status, 200);
  assert.equal((await post("reconnect", {})).status, 200);
  assert.equal(connections, 1);
  assert.deepEqual(client.settings, before);
});
