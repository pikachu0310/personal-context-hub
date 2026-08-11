import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChannelPaths,
  buildMessageSearchParams,
  normalizeWritePath,
  TraqClient,
} from "../src/traq-client.mjs";

test("buildMessageSearchParams preserves supported filters", () => {
  const params = buildMessageSearchParams({
    word: '"OAuth"',
    channelId: "00000000-0000-0000-0000-000000000001",
    fromUserIds: [
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000003",
    ],
    hasAttachments: false,
    limit: 20,
    offset: 0,
    sort: "-createdAt",
  });

  assert.equal(params.get("word"), '"OAuth"');
  assert.equal(params.get("in"), "00000000-0000-0000-0000-000000000001");
  assert.deepEqual(params.getAll("from"), [
    "00000000-0000-0000-0000-000000000002",
    "00000000-0000-0000-0000-000000000003",
  ]);
  assert.equal(params.get("hasAttachments"), "false");
  assert.equal(params.get("limit"), "20");
  assert.equal(params.get("offset"), "0");
});

test("buildChannelPaths creates stable nested paths", () => {
  const paths = buildChannelPaths([
    { id: "root", parentId: null, name: "team" },
    { id: "sysad", parentId: "root", name: "SysAd" },
    { id: "traq", parentId: "sysad", name: "traQ" },
  ]);

  assert.equal(paths.get("root"), "team");
  assert.equal(paths.get("sysad"), "team/SysAd");
  assert.equal(paths.get("traq"), "team/SysAd/traQ");
});

test("normalizeWritePath accepts relative API paths and rejects escapes", () => {
  assert.equal(
    normalizeWritePath("/messages/00000000-0000-0000-0000-000000000001"),
    "messages/00000000-0000-0000-0000-000000000001",
  );
  assert.throws(() => normalizeWritePath("https://example.com/steal"));
  assert.throws(() => normalizeWritePath("messages/%2e%2e/oauth2/revoke"));
  assert.throws(() => normalizeWritePath("messages\\escape"));
  assert.throws(() => normalizeWritePath("oauth2/revoke"));
  assert.throws(() =>
    normalizeWritePath(
      "bots/00000000-0000-0000-0000-000000000001/actions/reissue",
    ),
  );
});

test("apiWrite sends authenticated JSON only to the traQ API origin", async () => {
  let captured;
  const client = new TraqClient({
    fetchImpl: async (url, options) => {
      captured = { url: url.toString(), options };
      return {
        ok: true,
        status: 204,
        statusText: "No Content",
      };
    },
  });
  client.getToken = async () => ({
    accessToken: "test-access-token",
    tokenType: "Bearer",
    expiresAt: Date.now() + 60_000,
  });

  const result = await client.apiWrite({
    method: "POST",
    path: "messages/00000000-0000-0000-0000-000000000001/stamps/00000000-0000-0000-0000-000000000002",
    body: { count: 1 },
  });

  assert.equal(captured.url.startsWith("https://q.trap.jp/api/v3/"), true);
  assert.equal(captured.options.method, "POST");
  assert.equal(
    captured.options.headers.authorization,
    "Bearer test-access-token",
  );
  assert.equal(captured.options.body, JSON.stringify({ count: 1 }));
  assert.equal(result.ok, true);
});
