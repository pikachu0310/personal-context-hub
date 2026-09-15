import assert from "node:assert/strict";
import test from "node:test";
import {
  externalLink,
  localSender,
  parseJoinLink,
  parseProjectLink,
  previewRequestAllowed,
} from "../src/security.js";
test("preview frames may load only registered servers, without relaxing the main renderer", () => {
  const client = "http://127.0.0.1:4320";
  const preview = "http://127.0.0.1:50000";
  const registered = (url: string) =>
    url.replace(/^ws:/, "http:").startsWith(preview + "/");
  assert.equal(
    previewRequestAllowed(
      preview + "/",
      client + "/",
      "subFrame",
      client,
      registered,
    ),
    true,
  );
  assert.equal(
    previewRequestAllowed(
      preview + "/main.js",
      preview + "/",
      "script",
      client,
      registered,
    ),
    true,
  );
  assert.equal(
    previewRequestAllowed(
      "ws://127.0.0.1:50000/hmr",
      preview + "/",
      "webSocket",
      client,
      registered,
    ),
    true,
  );
  assert.equal(
    previewRequestAllowed(
      client + "/api/state",
      preview + "/",
      "xhr",
      client,
      registered,
    ),
    false,
  );
  assert.equal(
    previewRequestAllowed(
      "http://127.0.0.1:50001/",
      preview + "/",
      "xhr",
      client,
      registered,
    ),
    false,
  );
  assert.equal(
    previewRequestAllowed(
      preview + "/main.js",
      client + "/",
      "script",
      client,
      registered,
    ),
    false,
  );
  assert.equal(
    previewRequestAllowed(
      preview + "/",
      client + "/",
      "subFrame",
      client,
      () => false,
    ),
    false,
  );
});
test("join links accept only a single Engine origin and never encode task or credentials", () => {
  assert.equal(
    parseJoinLink(
      "ido-agent://connect?engine=https%3A%2F%2Fengine.example.com",
    ),
    "https://engine.example.com",
  );
  assert.equal(
    parseJoinLink("ido-agent://connect?engine=http%3A%2F%2F127.0.0.1%3A3000"),
    "http://127.0.0.1:3000",
  );
  assert.equal(
    parseJoinLink("ido-agent://connect?engine=http://engine.lan:4310"),
    "http://engine.lan:4310",
  );
  for (const link of [
    "https://connect?engine=https://example.com",
    "ido-agent://connect?engine=https://example.com&task=run",
    "ido-agent://connect?engine=https://example.com&engine=https://evil.example",
    "ido-agent://connect?engine=https://user:secret@example.com",
    "ido-agent://connect?engine=https://example.com/path",
    "ido-agent://connect?engine=file:///tmp",
  ])
    assert.throws(() => parseJoinLink(link));
});
test("desktop allows only its own renderer origin and exact active login or pairing URL", () => {
  assert.ok(localSender("http://127.0.0.1:4320/", "http://127.0.0.1:4320"));
  assert.ok(!localSender("http://127.0.0.1:4321/", "http://127.0.0.1:4320"));
  const pairing = "https://engine.example.com/pair?challenge=example";
  const login = "https://auth.openai.com/oauth/authorize?state=example";
  assert.ok(externalLink(pairing, pairing, login));
  const lanPairing = "http://engine.lan:4310/admin/pair/example";
  assert.ok(externalLink(lanPairing, lanPairing));
  assert.ok(!externalLink(lanPairing + "other", lanPairing));
  assert.ok(externalLink(login, pairing, login));
  const claude = "https://claude.ai/oauth/authorize?state=fixture";
  assert.ok(externalLink(claude, undefined, undefined, claude));
  assert.ok(!externalLink(claude, undefined, undefined, claude + "other"));
  assert.ok(
    !externalLink(
      "https://claude.ai.evil.example/oauth/authorize",
      undefined,
      undefined,
      "https://claude.ai.evil.example/oauth/authorize",
    ),
  );
  assert.ok(externalLink("https://code.claude.com/docs/en/authentication"));
  for (const url of [
    "file:///tmp/a",
    "https://evil.example",
    "https://auth.openai.com/other",
    "https://engine.example.com/other",
    "ido-agent://connect?engine=https://evil.example",
  ])
    assert.ok(!externalLink(url, pairing, login));
});

test("project links validate the invitation and Engine origin", () => {
  const token = "a".repeat(43);
  assert.deepEqual(
    parseProjectLink(
      `ido-agent://project?engine=https://engine.example.com&token=${token}`,
    ),
    { engineUrl: "https://engine.example.com", token },
  );
  assert.deepEqual(
    parseProjectLink(
      `ido-agent://project?engine=http://engine.lan:4310&token=${token}`,
    ),
    { engineUrl: "http://engine.lan:4310", token },
  );
  for (const link of [
    `ido-agent://project?engine=https://engine.example.com&token=${token}&task=run`,
    `ido-agent://project?engine=https://engine.example.com&token=${token}&token=${token}`,
    `ido-agent://project?engine=https://user:secret@engine.example.com&token=${token}`,
    `ido-agent://project?engine=https://engine.example.com&token=short`,
  ])
    assert.throws(() => parseProjectLink(link));
});
