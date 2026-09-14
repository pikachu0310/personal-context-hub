import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import { createOpenAICoordinatorFactory } from "../src/adapters/openai/coordinator.js";
import {
  coordinatorPrompt,
  parseCoordinatorResponse,
} from "../src/adapters/openai/coordinator-prompt.js";
import { describeError } from "../src/domain/diagnostics.js";
import type {
  CoordinatorObservation,
  CoordinatorHandle,
} from "@ido/common/contracts/coordinator";

const silent = { reply: null, tasks: [], controls: [] };
const observation = (
  id = "one",
  meetingId = "meeting",
): CoordinatorObservation => ({
  meetingId,
  mode: "text-speech",
  activeTasks: [],
  context: "previous question and answer",
  events: [
    {
      id,
      type: "message",
      source: {
        id,
        authorId: "actor",
        text: "質問",
        at: 1,
        origin: "text",
        requestReply: true,
      },
    },
  ],
});
function fixture(
  respond: (request: any, options: any) => Promise<any> = async () => ({
    status: "completed",
    output_text: JSON.stringify(silent),
  }),
) {
  const calls: any[] = [],
    keys: string[] = [];
  let key: string | undefined = "fixture-key";
  const factory = createOpenAICoordinatorFactory(
    { credentials: { get: async () => key } },
    {
      createClient: (apiKey) => {
        keys.push(apiKey);
        return {
          responses: {
            create: async (request: any, options: any) => {
              calls.push({ request, options });
              return respond(request, options);
            },
          },
        } as unknown as OpenAI;
      },
    },
  );
  return {
    factory,
    calls,
    keys,
    setKey: (value: string | undefined) => {
      key = value;
    },
  };
}

test("coordinator uses only Responses API and the current Engine API key, with context on every request", async (t) => {
  const f = fixture();
  t.after(() => f.factory.close());
  const handles: CoordinatorHandle[] = [];
  const runtime = await f.factory.createCoordinator({
    meetingId: "meeting",
    onCheckpoint: (h) => {
      handles.push(h);
    },
  });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await runtime.run(observation()), silent);
  f.setKey("replacement-key");
  assert.deepEqual(await runtime.run(observation("next")), silent);
  assert.deepEqual(f.keys, ["fixture-key", "replacement-key"]);
  assert.equal(handles[0].backend, "openai-responses");
  for (const { request, options } of f.calls) {
    assert.equal(request.model, "gpt-4.1-mini");
    assert.equal(request.store, false);
    assert.deepEqual(request.tools, []);
    assert.equal(request.previous_response_id, undefined);
    assert.match(request.input, /previous question and answer/);
    assert.equal(request.text.format.type, "json_schema");
    assert.equal(request.text.format.strict, true);
    assert.equal(options.maxRetries, 0);
    assert.equal(options.timeout, 60000);
  }
});

test("each prompt distinguishes current source IDs from historical and event IDs, including correction feedback", () => {
  const input = observation("event-id");
  if (input.events[0].type === "message")
    input.events[0].source.id = "message-id";
  input.taskValidation = {
    allowedSourceIds: ["message-id"],
    rejectedTasks: [],
  };
  for (const initial of [false, true]) {
    const prompt = coordinatorPrompt(input, { initial });
    const data = JSON.parse(prompt.split("\n").at(-1)!);
    assert.deepEqual(data.currentMessageSourceIds, ["message-id"]);
    assert.deepEqual(data.referenceOnly, ["context", "minutes", "activeTasks"]);
    assert.deepEqual(data.taskValidation, input.taskValidation);
    assert.match(prompt, /IDだけを機械的に置換しない/);
    assert.match(prompt, /今日の天気を調べて/);
  }
});

test("missing API key rejects before sending and recovers when configured", async (t) => {
  const f = fixture();
  t.after(() => f.factory.close());
  const runtime = await f.factory.createCoordinator({ meetingId: "meeting" });
  f.setKey(undefined);
  await assert.rejects(runtime.run(observation()), {
    code: "OPENAI_KEY_REQUIRED",
    delivery: "rejected",
  });
  assert.equal(f.calls.length, 0);
  f.setKey("configured");
  assert.deepEqual(await runtime.run(observation()), silent);
});

test("legacy Codex handles migrate without resuming a Codex thread; mismatched meetings reject", async (t) => {
  const f = fixture();
  t.after(() => f.factory.close());
  let saved: CoordinatorHandle | undefined;
  const runtime = await f.factory.createCoordinator({
    meetingId: "meeting",
    handle: { backend: "codex", meetingId: "meeting", threadId: "old-thread" },
    onCheckpoint: (h) => {
      saved = h;
    },
  });
  await runtime.run(observation());
  assert.equal(saved?.backend, "openai-responses");
  await assert.rejects(
    f.factory.createCoordinator({ meetingId: "other", handle: saved }),
    { code: "COORDINATOR_HANDLE_MISMATCH" },
  );
  await assert.rejects(f.factory.createCoordinator({ meetingId: "meeting" }), {
    code: "COORDINATOR_ALREADY_OPEN",
  });
  await assert.rejects(runtime.run(observation("wrong", "other")), {
    delivery: "rejected",
  });
  await assert.rejects(
    runtime.run({ ...observation(), context: "x".repeat(64001) }),
    { code: "COORDINATOR_INPUT_TOO_LARGE" },
  );
});

test("API authentication errors retain safe status/code/request ID and allow retry", async (t) => {
  const f = fixture(async () => {
    throw new OpenAI.AuthenticationError(
      401,
      { message: "private transcript sk-secret", code: "invalid_api_key" },
      undefined,
      new Headers({ "x-request-id": "req_fixture" }),
    );
  });
  t.after(() => f.factory.close());
  const runtime = await f.factory.createCoordinator({ meetingId: "meeting" });
  await assert.rejects(runtime.run(observation()), (error: any) => {
    const detail = describeError(error);
    assert.equal(error.delivery, "rejected");
    assert.equal(detail.status, 401);
    assert.equal(detail.code, "invalid_api_key");
    assert.equal(detail.requestId, "req_fixture");
    assert.ok(!JSON.stringify(error).includes("secret"));
    assert.ok(!JSON.stringify(detail).includes("transcript"));
    return true;
  });
});

test("connection failure, incomplete output and invalid JSON stay uncertain without replay", async (t) => {
  for (const respond of [
    async () => {
      throw new OpenAI.APIConnectionError({ message: "private" });
    },
    async () => ({ status: "incomplete", output_text: JSON.stringify(silent) }),
    async () => ({ status: "completed", output_text: "not json" }),
  ]) {
    const f = fixture(respond);
    t.after(() => f.factory.close());
    const runtime = await f.factory.createCoordinator({ meetingId: "meeting" });
    await assert.rejects(runtime.run(observation()), { delivery: "unknown" });
    assert.equal(f.calls.length, 1);
  }
});

test("busy and steering never start extra API calls; close aborts the active request", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = fixture(
    async (_request, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
        started();
      }),
  );
  const runtime = await f.factory.createCoordinator({ meetingId: "meeting" });
  const pending = assert.rejects(runtime.run(observation()), {
    delivery: "unknown",
  });
  await ready;
  await assert.rejects(runtime.run(observation()), {
    code: "COORDINATOR_BUSY",
  });
  assert.equal(await runtime.steer(observation("urgent")), false);
  assert.equal(f.calls.length, 1);
  await f.factory.close();
  await pending;
  await assert.rejects(runtime.run(observation()), {
    code: "COORDINATOR_CLOSED",
  });
  await assert.rejects(f.factory.createCoordinator({ meetingId: "new" }), {
    code: "COORDINATOR_CLOSED",
  });
});

test("response parsing defaults empty lists but rejects malformed task authority and ignores invented grants", () => {
  assert.deepEqual(parseCoordinatorResponse('{"reply":null}'), silent);
  assert.throws(() =>
    parseCoordinatorResponse(
      '{"tasks":[{"title":"x","kind":"research","sourceIds":[]}]}',
    ),
  );
  const parsed = parseCoordinatorResponse(
    JSON.stringify({
      reply: null,
      tasks: [
        {
          title: "Inspect",
          kind: "research",
          sourceIds: ["source"],
          acceptanceCriteria: [],
          network: true,
          sandboxMode: "danger-full-access",
          authorId: "admin",
        },
      ],
    }),
  );
  assert.deepEqual(parsed.tasks[0], {
    title: "Inspect",
    kind: "research",
    sourceIds: ["source"],
    acceptanceCriteria: [],
  });
  assert.match(
    coordinatorPrompt({ ...observation(), mode: "live" }, { initial: true }),
    /Liveが音声会話を担当/,
  );
});

test("speech decisions require a matching-shaped candidate, revision and bounded replacement", () => {
  assert.equal(parseCoordinatorResponse('{"reply":null}').speech, undefined);
  const speech = {
    candidateId: "candidate",
    revision: 3,
    action: "replace",
    text: "短い回答",
  };
  assert.deepEqual(
    parseCoordinatorResponse(JSON.stringify({ speech })).speech,
    speech,
  );
  for (const invalid of [
    { ...speech, revision: -1 },
    { ...speech, revision: 1.5 },
    { ...speech, candidateId: "" },
    { ...speech, action: "replay" },
    { ...speech, text: "x".repeat(2001) },
    { ...speech, text: "" },
    { ...speech, action: "continue" },
  ])
    assert.throws(
      () => parseCoordinatorResponse(JSON.stringify({ speech: invalid })),
      /INVALID_COORDINATOR_RESPONSE/,
    );
});

test("scoring shares the extraction call and malformed ratings preserve topics and replies", async (t) => {
  const { evaluation } = await import("./priority-fixture.js");
  const { coordinatorSchema } =
    await import("../src/adapters/openai/coordinator-prompt.js");
  const wire = {
    ...silent,
    priorityEvaluations: [],
    speech: null,
    minutes: [],
    reply: {
      text: "独立した回答",
      reason: "direct_answer",
      sourceIds: ["one"],
      delivery: "notify",
    },
    tasks: [
      {
        title: "調査",
        kind: "research",
        sourceIds: ["one"],
        acceptanceCriteria: ["出典"],
        evaluation: evaluation(["one"]),
      },
    ],
  };
  const f = fixture(async () => ({
    status: "completed",
    output_text: JSON.stringify(wire),
  }));
  t.after(() => f.factory.close());
  const runtime = await f.factory.createCoordinator({ meetingId: "meeting" });
  const result = await runtime.run(observation());
  assert.equal(f.calls.length, 1);
  assert.equal(result.tasks[0].evaluation?.specificity, 4);
  const bad = parseCoordinatorResponse(
    JSON.stringify({
      ...wire,
      tasks: [
        {
          ...wire.tasks[0],
          evaluation: { ...wire.tasks[0].evaluation, certainty: 9 },
        },
      ],
    }),
  );
  assert.equal(bad.tasks[0].evaluation, null);
  assert.equal(bad.reply?.text, "独立した回答");
  assert.deepEqual(bad.minutes, []);
  const inspect = (schema: any) => {
    if (schema.type === "object")
      assert.deepEqual(
        [...schema.required].sort(),
        Object.keys(schema.properties).sort(),
      );
    for (const value of Object.values(schema))
      if (value && typeof value === "object") {
        if (Array.isArray(value))
          for (const item of value)
            if (item && typeof item === "object") inspect(item);
            else {
            }
        if (!Array.isArray(value)) inspect(value);
      }
  };
  inspect(coordinatorSchema);
});

test("topic extraction instructions retain the fixed distinction between proposals, decisions and postponement", () => {
  const prompt = coordinatorPrompt(observation(), { initial: true });
  for (const text of [
    "試作の依頼を製品仕様の本採用と同一視しません",
    "延期を記録してもDB方式は未決のまま",
    "仕事の判断に関係しない天気・食事・挨拶は、原発言ログだけに残します",
    "訂正は以前の議題を更新して反映し、無関係な既存議題は変更しません",
  ])
    assert.ok(prompt.includes(text));
});

test("a new API task with missing scoring cannot enter the saved-legacy compatibility path", async (t) => {
  const f = fixture(async () => ({
    status: "completed",
    output_text: JSON.stringify({
      ...silent,
      tasks: [
        {
          title: "未評価",
          kind: "research",
          sourceIds: ["one"],
          acceptanceCriteria: [],
        },
      ],
    }),
  }));
  t.after(() => f.factory.close());
  const runtime = await f.factory.createCoordinator({ meetingId: "meeting" });
  const response = await runtime.run(observation());
  assert.equal(response.tasks[0].evaluation, null);
});
