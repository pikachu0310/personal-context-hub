import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import OpenAI from "openai";
import { Store } from "../src/adapters/sqlite/store.js";
import { describeError } from "../src/domain/diagnostics.js";

test("SDK quota errors retain useful metadata without provider messages or headers", () => {
  const error = new OpenAI.RateLimitError(
    429,
    {
      type: "insufficient_quota",
      code: null,
      param: "model",
      message: "private transcript and sk-secret-value",
    },
    undefined,
    new Headers({
      "x-request-id": "req_test123",
      authorization: "Bearer secret",
    }),
  );
  assert.deepEqual(describeError(error), {
    type: "RateLimitError",
    code: "insufficient_quota",
    cause: undefined,
    status: 429,
    requestId: "req_test123",
    parameter: "model",
    providerErrorType: undefined,
    reason:
      "OpenAI APIの利用枠が不足しています。請求設定・残高・利用上限を確認してください。",
  });
  const serialized = JSON.stringify(describeError(error));
  assert.ok(!serialized.includes("secret"));
  assert.ok(!serialized.includes("transcript"));
});

test("network causes, timeout, missing meeting and invalid audio are distinguishable", () => {
  const network = new OpenAI.APIConnectionError({
    cause: Object.assign(new Error("private hostname"), { code: "ENOTFOUND" }),
  });
  assert.equal(describeError(network).cause, "ENOTFOUND");
  assert.equal(
    describeError(new OpenAI.APIConnectionTimeoutError()).type,
    "APIConnectionTimeoutError",
  );
  assert.equal(
    describeError(new Error("MEETING_NOT_FOUND")).code,
    "MEETING_NOT_FOUND",
  );
  assert.equal(
    describeError(new Error("INVALID_PCM_WAV")).code,
    "INVALID_PCM_WAV",
  );
  assert.ok(
    !JSON.stringify(
      describeError(
        Object.assign(new Error("private text"), {
          code: "sk-secret",
          requestID: "private text",
          param: "private text",
          body: "private text",
        }),
      ),
    ).includes("private"),
  );
});

test("diagnostics survive restart, keep the latest 500 and return the newest 100", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ido-diagnostics-"));
  let store = new Store(dir);
  try {
    for (let i = 0; i < 505; i++)
      store.logError(new Error("OPENAI_KEY_REQUIRED"), {
        source: "discord-voice",
        operation: "audio.transcribe",
        eventId: String(i),
      });
    store.close();
    store = new Store(dir);
    const entries = store.diagnostics();
    assert.equal(entries.length, 100);
    assert.equal(entries[0].eventId, "504");
    assert.equal(entries[99].eventId, "405");
    assert.equal(
      store.db.prepare("SELECT COUNT(*) count FROM diagnostics").get()!.count,
      500,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("nested fetch failures retain only the safe socket cause and terminate on cycles", () => {
  const socket = Object.assign(new Error("private host and credentials"), {
    code: "UND_ERR_CONNECT_TIMEOUT",
  });
  const error = new OpenAI.APIConnectionError({
    cause: new TypeError("fetch failed", { cause: socket }),
  });
  const detail = describeError(error);
  assert.equal(detail.cause, "UND_ERR_CONNECT_TIMEOUT");
  assert.match(detail.reason, /タイムアウト/);
  assert.doesNotMatch(JSON.stringify(detail), /private|credentials/);
  const cycle: any = { code: "secret" };
  cycle.cause = cycle;
  assert.equal(describeError({ cause: cycle }).cause, undefined);
  const file = describeError({
    code: "invalid_value",
    param: "file",
    status: 400,
  });
  assert.match(file.reason, /音声の長さ/);
});
