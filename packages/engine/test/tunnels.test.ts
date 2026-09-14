import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { Credentials } from "../../common/src/credentials.js";
import { Tunnels } from "../src/tunnels.js";

async function until(check: () => boolean) {
  for (let n = 0; n < 150; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("TUNNEL_TEST_TIMEOUT");
}
test("ngrok auto-installs, opens one tunnel, captures assigned URL, redacts errors and can retry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-tunnel-"));
  const store = new Store(directory);
  const credentials = new Credentials(directory, "test", "file");
  const tunnels = new Tunnels(directory, store, credentials);
  tunnels.workerPath = fileURLToPath(
    new URL("../src/tunnel-worker.ts", import.meta.url),
  );
  t.after(async () => {
    tunnels.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  let installs = 0;
  tunnels.install = async (provider) => {
    installs++;
    const moduleDir = join(directory, "node_modules/@ngrok/ngrok");
    await mkdir(moduleDir, { recursive: true });
    await writeFile(
      join(moduleDir, "index.js"),
      `
      let calls = 0;
      exports.forward = async (config) => {
        if (++calls > 1) throw Error('second tunnel forbidden');
        if (config.authtoken === 'bad-test-token') throw Error('secret bad-test-token ERR_NGROK_105');
        if (config.addr !== '127.0.0.1:4310') throw Error('wrong target');
        return { url: () => 'https://' + (config.domain || 'assigned.ngrok-free.app') };
      };
      exports.disconnect = async () => {};
    `,
    );
    store.put("tunnel", provider, { directory });
  };
  await assert.rejects(
    tunnels.start("ngrok", { engine: 4310 }),
    /TUNNEL_CREDENTIAL_REQUIRED/,
  );
  assert.equal(installs, 0);
  await credentials.set("tunnel.ngrok", "good-test-token");
  await tunnels.start("ngrok", { engine: 4310 });
  await until(() => tunnels.status.startsWith("running"));
  assert.equal(installs, 1);
  assert.deepEqual(store.get("config", "public"), {
    provider: "ngrok",
    engineUrl: "https://assigned.ngrok-free.app",
  });
  tunnels.stop();
  await credentials.set("tunnel.ngrok", "bad-test-token");
  await tunnels.start("ngrok", { engine: 4310 });
  await until(() => !tunnels.child);
  assert.equal(tunnels.status, "failed");
  assert.equal(tunnels.error, "ERR_NGROK_105");
  assert.equal(
    store.get<any>("config", "public").engineUrl,
    "https://assigned.ngrok-free.app",
  );
  await credentials.set("tunnel.ngrok", "good-test-token");
  await tunnels.start("ngrok", { engine: 4310 }, "https://reserved.ngrok.app");
  await until(() => tunnels.status.startsWith("running"));
  assert.equal(
    store.get<any>("config", "public").engineUrl,
    "https://reserved.ngrok.app",
  );
  assert.equal(installs, 1);
  assert.equal(tunnels.error, undefined);
});
