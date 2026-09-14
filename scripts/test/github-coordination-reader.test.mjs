import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_OUTPUT_CHARS,
  readCoordination,
} from "../read-github-coordination.mjs";

const REPO = "pikachu0310/personal-context-hub-discord-voice";
const DATE = "2026-09-13T00:00:00.000Z";
const source = (id, body = "message") => ({
  id,
  body,
  updated_at: DATE,
  user: { login: "member-a" },
  issue_url: `https://api.github.com/repos/${REPO}/issues/16`,
});

function fixture(count) {
  const calls = [];
  const request = (endpoint) => {
    calls.push(endpoint);
    if (!endpoint.includes("comments"))
      return {
        date: DATE,
        data: { ...source(16, "instructions"), comments: count },
      };
    const query = new URLSearchParams(endpoint.split("?")[1]);
    const start = (Number(query.get("page")) - 1) * 10;
    return {
      date: DATE,
      data: Array.from(
        { length: Math.min(10, Math.max(0, count - start)) },
        (_, i) => source(start + i + 1),
      ),
    };
  };
  return { calls, request };
}

test("default read fetches only the last page of a long issue", () => {
  const data = fixture(1000);
  const result = readCoordination({}, data.request);
  assert.equal(data.calls.length, 2);
  assert.match(data.calls[1], /per_page=10&page=100$/);
  assert.equal(result.older_comments_omitted, 990);
  assert.equal(
    result.items.filter((item) => item.kind === "comment").length,
    10,
  );
  assert.equal(result.next, null);
});

test("delta pages return ready-to-use commands retaining the first poll boundary", () => {
  const data = fixture(12);
  const since = "2026-09-12T00:00:00.000Z";
  const first = readCoordination({ since }, data.request);
  assert.match(first.next, /--page 2/);
  assert.match(first.next, /--since 2026-09-12T00:00:00.000Z/);
  assert.match(first.next_poll, /--since 2026-09-12T23:59:59.000Z/);
  const second = readCoordination(
    { since, page: "2", "poll-from": "2026-09-12T23:59:59.000Z" },
    data.request,
  );
  assert.equal(second.items.length, 2);
  assert.equal(second.next, null);
  assert.equal(second.next_poll, first.next_poll);
});

test("serialized output stays bounded with long escaped text and Unicode", () => {
  const body = '😀\u0000"\\\n'.repeat(10000);
  const result = readCoordination({ since: DATE }, (endpoint) => ({
    date: DATE,
    data: endpoint.includes("comments")
      ? Array.from({ length: 10 }, (_, i) => source(i + 1, body))
      : { ...source(16, "instructions"), comments: 10 },
  }));
  assert.ok(JSON.stringify(result).length + 1 <= MAX_OUTPUT_CHARS);
  const comments = result.items.filter((item) => item.kind === "comment");
  assert.equal(comments.length, 10);
  for (const item of comments) {
    assert.ok(item.truncated);
    assert.ok(item.read_more);
    assert.ok(!/[\ud800-\udbff]$/.test(item.body));
  }
});

test("a long comment can be read completely through bounded continuation", () => {
  const body = "😀discussion ".repeat(1000);
  let offset = "0";
  let version;
  let rebuilt = "";
  for (let i = 0; i < 30; i += 1) {
    const result = readCoordination({ comment: "42", offset, version }, () => ({
      date: DATE,
      data: source(42, body),
    }));
    assert.ok(JSON.stringify(result).length + 1 <= MAX_OUTPUT_CHARS);
    const item = result.items[0];
    rebuilt += item.body;
    offset = String(item.offset + item.body.length);
    version = item.version;
    if (!result.next) break;
  }
  assert.equal(rebuilt, body);
});

test("an edited comment restarts rather than using an obsolete text offset", () => {
  const original = readCoordination({ comment: "42" }, () => ({
    date: DATE,
    data: source(42, "old".repeat(1000)),
  }));
  const edited = readCoordination(
    { comment: "42", offset: "2000", version: original.items[0].version },
    () => ({ date: DATE, data: source(42, "new") }),
  );
  assert.equal(edited.items[0].body, "new");
  assert.equal(edited.items[0].offset, 0);
  assert.equal(edited.items[0].restarted, true);
});

test("invalid arguments and cross-issue comments are rejected", () => {
  assert.throws(() =>
    readCoordination({ issue: "../other" }, () =>
      assert.fail("unexpected request"),
    ),
  );
  assert.throws(() =>
    readCoordination({ since: "invalid" }, () =>
      assert.fail("unexpected request"),
    ),
  );
  assert.throws(() =>
    readCoordination({ comment: "42", body: true }, () =>
      assert.fail("unexpected request"),
    ),
  );
  assert.throws(() =>
    readCoordination({ issue: "17", comment: "42" }, () => ({
      date: DATE,
      data: source(42),
    })),
  );
});

test("an API failure returns no next-poll cursor", () => {
  assert.throws(
    () =>
      readCoordination({ since: DATE }, () => {
        throw new Error("offline");
      }),
    /offline/,
  );
});

test("periodic reads also include an updated issue description", () => {
  const data = fixture(0);
  const result = readCoordination(
    { since: "2026-09-12T23:59:59.000Z" },
    data.request,
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, "issue");
  assert.equal(result.items[0].body, "instructions");
});
