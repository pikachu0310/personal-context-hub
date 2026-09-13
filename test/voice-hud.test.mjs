import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { createTelemetry } from "../src/engine/telemetry.mjs";
import { createConversationEngine } from "../src/engine/conversation.mjs";
import { createHudStore, startHudServer } from "../src/runtime/hud-server.mjs";
import {
  normalizeExecutionEvent,
  notifyExecutionEvent,
} from "../src/execution/telemetry.mjs";
import { bindExecution } from "../src/execution/port.mjs";

const waitFor = async (check) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for observation");
};
const latest = (events) => [
  ...new Map(events.map((e) => [e.spanId, e])).values(),
];

test("HUD allowlist drops raw tool data/audio and bounds history", () => {
  const store = createHudStore();
  for (let i = 0; i < 1010; i++)
    store.publish({
      stage: "EXECUTE",
      status: "running",
      spanId: String(i),
      text: "Bearer abc123",
      token: "secret",
      audio: Buffer.from("private"),
      raw: { reasoning: "private" },
    });
  const snapshot = store.snapshot();
  assert.equal(snapshot.events.length, 1000);
  assert.equal(snapshot.events[0].sequence, 11);
  assert.equal(snapshot.sequence, 1010);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|private|abc123/);
  snapshot.events.length = 0;
  assert.equal(store.snapshot().events.length, 1000);
  store.publish({ stage: "UNKNOWN", status: "running" });
  assert.equal(store.snapshot().sequence, 1010);
});

test("SDK event normalization preserves explicit query but never reasoning or raw results", () => {
  assert.equal(
    normalizeExecutionEvent({
      type: "item.completed",
      item: { type: "reasoning", text: "search for credentials" },
    }),
    undefined,
  );
  const event = normalizeExecutionEvent({
    type: "item.updated",
    item: {
      id: "search",
      type: "web_search",
      query: "streaming STT",
      result: { secret: "raw" },
    },
  });
  assert.equal(event.query, "streaming STT");
  assert.equal(event.status, "running");
  assert.equal(event.summary, undefined);
  const tool = normalizeExecutionEvent({
    type: "item.completed",
    item: {
      id: "tool",
      type: "mcp_tool_call",
      tool: "search",
      arguments: { token: "secret" },
      result: "raw",
      status: "failed",
    },
  });
  assert.equal(tool.status, "failed");
  assert.doesNotMatch(JSON.stringify(tool), /secret|raw/);
  assert.doesNotThrow(() =>
    notifyExecutionEvent(() => {
      throw Error("observer");
    }, event),
  );
});

test("execution port forwards structured callbacks without replacing text progress", async () => {
  const seen = [];
  const execution = bindExecution({
    async runTask(_task, options) {
      options.onEvent({ tool: "web_search" });
      options.onProgress("existing text");
      return { text: "done", state: {} };
    },
  });
  assert.equal(
    await execution.runTask(
      { id: "t" },
      { onEvent: (e) => seen.push(e), onProgress: (t) => seen.push(t) },
    ),
    "done",
  );
  assert.deepEqual(seen, [{ tool: "web_search" }, "existing text"]);
});

test("observer exceptions and rejected promises do not change engine work", async () => {
  for (const sink of [
    () => {
      throw Error("observer");
    },
    async () => {
      throw Error("observer");
    },
  ]) {
    const telemetry = createTelemetry(sink);
    assert.equal(await telemetry.wrap("STT", async () => "ok")(), "ok");
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test("parallel input scopes survive delivery and speech without crossing associations", async () => {
  const events = [],
    releases = [];
  const engine = await createConversationEngine({
    config: {
      voiceMode: "meeting",
      allowedUserId: "operator",
      observationIntervalMs: 60000,
    },
    onEvent: (e) => events.push(e),
    logger: { info() {} },
    audio: {
      transcribe: () => new Promise((resolve) => releases.push(resolve)),
      synthesize: async () => Buffer.from("audio"),
    },
    execution: {
      observeMeeting: async () =>
        JSON.stringify({
          minutes: "",
          shouldReply: true,
          reply: "回答",
          tasks: [],
          taskControls: [],
        }),
    },
    output: {
      capabilities: { audio: true },
      postText: async () => {},
      playAudio: async () => {},
    },
  });
  try {
    engine.input.enqueue(Buffer.from("a"), { speakerName: "話者A" });
    engine.input.enqueue(Buffer.from("b"), { speakerName: "話者B" });
    await waitFor(() => releases.length === 2);
    releases[1]("second");
    releases[0]("first");
    await waitFor(() => engine.session.activeTranscriptions === 0);
    const stt = events.filter((e) => e.stage === "STT" && e.text);
    assert.equal(
      stt
        .find((e) => e.text === "first")
        .inputIds[0].split(":")
        .at(-1),
      "I-1",
    );
    assert.equal(
      stt
        .find((e) => e.text === "second")
        .inputIds[0].split(":")
        .at(-1),
      "I-2",
    );
    await engine.session.observeNow();
    const delivered = events.find(
      (e) => e.stage === "DELIVER" && e.text?.includes("回答"),
    );
    const playback = events.find(
      (e) => e.stage === "PLAYBACK" && e.status === "completed",
    );
    assert.deepEqual(playback.inputIds, delivered.inputIds);
    assert.equal(playback.inputIds.length, 2);
    assert.ok(events.some((e) => e.stage === "TTS" && e.status === "waiting"));
    assert.ok(
      latest(events).every((e) => !["waiting", "running"].includes(e.status)),
    );
  } finally {
    await engine.session.stop();
  }
});

test("timeouts, cancellation and failures have terminal telemetry even if provider ignores abort", async () => {
  for (const [code, expected, reason] of [
    ["STAGE_TIMEOUT", "failed", "timeout"],
    ["SERVICE_STOPPED", "interrupted", "aborted"],
  ]) {
    const events = [],
      controller = new AbortController();
    const telemetry = createTelemetry((e) => events.push(e));
    let release;
    const work = telemetry.wrap(
      "EXECUTE",
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )(null, { signal: controller.signal });
    controller.abort(Object.assign(Error("private failure"), { code }));
    assert.equal(events.at(-1).status, expected);
    assert.equal(events.at(-1).reason, reason);
    release("late");
    await work;
    assert.equal(events.length, 2);
  }
  const events = [];
  await assert.rejects(
    createTelemetry((e) => events.push(e)).wrap("STT", async () => {
      throw Error("credential secret");
    })(),
  );
  assert.equal(events.at(-1).status, "failed");
  assert.doesNotMatch(JSON.stringify(events), /credential secret/);
});

test("task queue phase durations and multiple-source links remain explicit", () => {
  const events = [],
    telemetry = createTelemetry((e) => events.push(e));
  const task = {
    id: "T-1",
    meetingId: "meeting",
    title: "調査",
    sourceSequences: [1, 2],
    state: "queued",
  };
  telemetry.taskState(task);
  telemetry.taskState(task);
  assert.equal(events.length, 2);
  telemetry.taskState({ ...task, state: "running" });
  telemetry.taskState({ ...task, state: "completed" });
  assert.ok(events.some((e) => e.stage === "QUEUE" && e.status === "waiting"));
  assert.deepEqual(events.at(-1).inputIds, ["meeting:I-1", "meeting:I-2"]);
  assert.ok(latest(events).every((e) => e.status === "completed"));
});

const http = (url, options = {}) =>
  new Promise((resolve, reject) => {
    const req = request(url, options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body }),
      );
    });
    req.on("error", reject);
    req.end();
  });
test("localhost server enforces origin/Host/method and supports SSE replay, gaps and disconnects", async () => {
  const server = await startHudServer({ port: 0 });
  try {
    const state = await http(server.url + "/api/snapshot");
    assert.equal(state.status, 200);
    assert.equal(state.headers["cache-control"], "no-store");
    assert.equal(
      (
        await http(server.url + "/api/snapshot", {
          headers: { Origin: "https://external.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await http(server.url + "/api/snapshot", {
          headers: { Host: "external.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await http(server.url + "/api/snapshot", { method: "POST" })).status,
      405,
    );
    assert.equal(
      (
        await http(server.url + "/api/snapshot", {
          headers: { "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
      403,
    );
    server.store.publish({ stage: "STT", status: "running", spanId: "s" });
    const snapshot = server.store.snapshot();
    const readStream = async (after, session = snapshot.sessionId) => {
      const controller = new AbortController();
      const response = await fetch(
        `${server.url}/api/events?after=${after}&session=${session}`,
        { signal: controller.signal },
      );
      const reader = response.body.getReader();
      const chunk = new TextDecoder().decode((await reader.read()).value);
      controller.abort();
      return chunk;
    };
    assert.match(await readStream(0), /event: observation/);
    assert.match(await readStream(50), /event: reset/);
    assert.match(await readStream(0, "old-session"), /event: reset/);
    for (let i = 0; i < 1001; i++)
      server.store.publish({
        stage: "STT",
        status: "completed",
        spanId: String(i),
      });
    assert.match(await readStream(0), /event: reset/);
    server.store.publish({
      stage: "STT",
      status: "completed",
      spanId: "after-disconnect",
    });
    assert.equal(
      server.store.snapshot().events.at(-1).spanId,
      "after-disconnect",
    );
  } finally {
    await server.close();
  }
});

test("long-running work survives history eviction and disappears from active state on completion", () => {
  const store = createHudStore();
  store.publish({
    stage: "EXECUTE",
    status: "running",
    spanId: "long-task",
    at: 100,
  });
  for (let i = 0; i < 1005; i++)
    store.publish({ stage: "STT", status: "completed", spanId: `short-${i}` });
  assert.equal(store.snapshot().events.length, 1000);
  assert.equal(store.snapshot().active[0].spanId, "long-task");
  assert.equal(store.snapshot().active[0].startedAt, 100);
  store.publish({
    stage: "EXECUTE",
    status: "completed",
    spanId: "long-task",
    at: 10000,
  });
  assert.equal(store.snapshot().active.length, 0);
  assert.equal(store.snapshot().events.at(-1).startedAt, 100);
});

test("Codex runner emits normalized lifecycle and closes unfinished tools on stream failure", async () => {
  const { CodexVoiceRunner } =
    await import("../src/execution/codex/runner.mjs");
  const events = [];
  const runner = new CodexVoiceRunner(
    { workingDirectory: "/tmp", powerMode: true },
    {
      codex: {
        startThread: () => ({
          id: "fixture-thread",
          runStreamed: async () => ({
            events: (async function* () {
              yield {
                type: "item.started",
                item: {
                  id: "search",
                  type: "web_search",
                  query: "latency comparison",
                },
              };
              yield {
                type: "item.updated",
                item: {
                  id: "search",
                  type: "web_search",
                  query: "streaming latency comparison",
                },
              };
              yield {
                type: "turn.failed",
                error: { message: "synthetic failure" },
              };
            })(),
          }),
        }),
      },
    },
  );
  await assert.rejects(
    runner.runTask(
      { title: "fixture", request: "search" },
      { onEvent: (e) => events.push(e) },
    ),
    /synthetic failure/,
  );
  assert.deepEqual(
    events.map((e) => e.status),
    ["running", "running", "interrupted"],
  );
  assert.ok(events.every((e) => e.runId === "1"));
  assert.equal(events.at(-1).reason, "completion_unprovided");
});

test("shutdown settles pending STT and assembly intervals", async () => {
  const events = [];
  const engine = await createConversationEngine({
    config: { voiceMode: "meeting", transcriptionConcurrency: 1 },
    audio: { transcribe: () => new Promise(() => {}) },
    execution: {},
    output: { postText: async () => {} },
    onEvent: (event) => events.push(event),
    logger: { info() {} },
  });
  engine.input.enqueue(Buffer.from("one"));
  engine.input.enqueue(Buffer.from("two"));
  await engine.session.stop();
  assert.ok(
    latest(events).every(
      (event) => !["waiting", "running"].includes(event.status),
    ),
  );
  assert.ok(
    events.some(
      (event) => event.stage === "ASSEMBLE" && event.status === "interrupted",
    ),
  );
});
