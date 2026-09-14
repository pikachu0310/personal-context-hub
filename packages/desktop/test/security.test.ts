import assert from "node:assert/strict";
import test from "node:test";
import { externalLink, localSender, parseJoinLink } from "../src/security.js";
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
  for (const link of [
    "https://connect?engine=https://example.com",
    "ido-agent://connect?engine=https://example.com&task=run",
    "ido-agent://connect?engine=https://example.com&engine=https://evil.example",
    "ido-agent://connect?engine=https://user:secret@example.com",
    "ido-agent://connect?engine=http://example.com",
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
  assert.ok(externalLink(login, pairing, login));
  for (const url of [
    "file:///tmp/a",
    "https://evil.example",
    "https://auth.openai.com/other",
    "https://engine.example.com/other",
    "ido-agent://connect?engine=https://evil.example",
  ])
    assert.ok(!externalLink(url, pairing, login));
});
