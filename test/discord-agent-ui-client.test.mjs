import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createAgentUi } from "../src/discord-agent-ui.mjs";
import { encodeAgentInvitation } from "../src/discord-agent-onboarding.mjs";

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Browser client did not finish the expected operation");
}

test("invitation landing autofills an authorized tab without connecting or transferring capabilities", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-ui-client-"));
  let connections = 0;
  const login = {
    state: { authenticated: true, pending: false },
    refresh: async function () {
      return this.state;
    },
    start() {
      assert.fail("Invitation must not initiate login");
    },
    stop() {},
  };
  const ui = await createAgentUi({
    directory,
    login,
    validateRepository: async () => {},
    createExecutor: () => ({}),
    createWorker: () => ({
      authenticated: true,
      socket: { readyState: 1 },
      connect: async () => {
        connections++;
      },
      stop: async () => {},
    }),
  });
  const origin = new URL(ui.url).origin;
  const channels = [];
  const timers = [];
  const messages = [];
  const namespace = randomUUID();
  class Channel extends BroadcastChannel {
    constructor(name) {
      super(`${namespace}:${name}`);
      channels.push(this);
    }
    postMessage(data) {
      messages.push(data);
      super.postMessage(data);
    }
  }
  t.after(async () => {
    for (const channel of channels) channel.close();
    for (const timer of timers) clearTimeout(timer);
    await ui.close();
    await rm(directory, { recursive: true, force: true });
  });
  const browser = async (file, hash) => {
    const elements = new Map();
    const element = (id) => {
      if (!elements.has(id))
        elements.set(id, {
          value: "",
          textContent: "",
          checked: false,
          replaceChildren() {},
          addEventListener() {},
        });
      return elements.get(id);
    };
    let cleanUrl;
    const storage = new Map();
    const location = { hash };
    const events = new Map();
    runInNewContext(
      await readFile(new URL(`../src/${file}`, import.meta.url), "utf8"),
      {
        document: { getElementById: element },
        location,
        history: {
          replaceState: (_state, _title, path) => {
            cleanUrl = path;
          },
        },
        sessionStorage: {
          getItem: (key) => storage.get(key),
          setItem: (key, value) => storage.set(key, value),
        },
        crypto: { randomUUID },
        BroadcastChannel: Channel,
        fetch: (path, options) =>
          fetch(new URL(path, origin), {
            ...options,
            headers: { ...options.headers, Origin: origin },
          }),
        setTimeout: (fn, ms) => {
          const timer = setTimeout(fn, ms);
          timers.push(timer);
          return timer;
        },
        clearTimeout,
        setInterval() {},
        addEventListener: (name, callback) => events.set(name, callback),
      },
    );
    return {
      element,
      cleanUrl,
      storage,
      navigate: (hash) => {
        location.hash = hash;
        events.get("hashchange")();
      },
    };
  };
  const main = await browser(
    "discord-agent-ui-client.js",
    new URL(ui.url).hash,
  );
  await until(() =>
    main.element("auth-status").textContent.includes("ログイン済み"),
  );
  main.element("workdir").value = "/own/repository";
  main.element("automatic").checked = true;
  main.element("network").checked = true;
  const pairing = {
    gatewayUrl: "wss://agents.example.com",
    code: "ABCDEFGHIJKL",
    expiresAt: Date.now() + 60_000,
  };
  // Even a hand-crafted invitation cannot inject a local path or permissions.
  const invitation = `ido1.${Buffer.from(JSON.stringify({ ...pairing, workingDirectory: "/attacker/path", automatic: true, networkAccess: true })).toString("base64url")}`;
  const landing = await browser(
    "discord-agent-join-client.js",
    `#${invitation}`,
  );
  await until(() =>
    landing.element("status").textContent.startsWith("入力しました"),
  );
  assert.equal(main.element("gateway").value, pairing.gatewayUrl);
  assert.equal(main.element("code").value, pairing.code);
  assert.equal(main.element("workdir").value, "/own/repository");
  assert.equal(main.element("automatic").checked, false);
  assert.equal(main.element("network").checked, false);
  assert.equal(landing.cleanUrl, "/join");
  assert.equal(landing.storage.size, 0);
  assert.equal(connections, 0);
  assert.ok(!JSON.stringify(messages).includes(new URL(ui.url).hash.slice(1)));
  const expired = await browser(
    "discord-agent-join-client.js",
    `#${encodeAgentInvitation({ ...pairing, code: "MNOPQRSTUVWX", expiresAt: Date.now() - 1 })}`,
  );
  await until(() =>
    expired.element("status").textContent.startsWith("入力できません"),
  );
  assert.equal(main.element("code").value, pairing.code);
  const response = await fetch(`${origin}/connect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${new URL(ui.url).hash.slice(1)}`,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workingDirectory: directory,
      gatewayUrl: pairing.gatewayUrl,
      pairingCode: pairing.code,
    }),
  });
  assert.equal(response.status, 200);
  landing.navigate(
    `#${encodeAgentInvitation({ ...pairing, gatewayUrl: "wss://other.example.com" })}`,
  );
  await until(() =>
    landing.element("status").textContent.startsWith("入力できません"),
  );
  assert.equal(main.element("gateway").value, pairing.gatewayUrl);
  assert.equal(connections, 1);
});
