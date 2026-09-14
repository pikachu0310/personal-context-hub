import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { bindCoordinator } from "../src/execution/coordinator-port.mjs";
import { createCodexBackend } from "../src/execution/codex/backend.mjs";
import { CodexVoiceRunner } from "../src/execution/codex/runner.mjs";
import { AppServerCodex } from "../src/execution/codex/app-server.mjs";

const response = JSON.stringify({
  minutes: "",
  shouldReply: false,
  reply: "",
  replyReason: "none",
  replySourceSequences: [],
  tasks: [],
  taskControls: [],
  decisions: [],
});
const observation = (sequence = 1) => ({
  meetingId: "meeting-1",
  conversationMode: "text",
  statements: [
    {
      id: `input-${sequence}`,
      sequence,
      userId: "operator",
      text: `発言${sequence}`,
      requestReply: true,
      readOnlyResearchEligible: true,
    },
  ],
  memory: "initial-memory-only",
  minutes: "initial-log-only",
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function eventually(check) {
  const deadline = Date.now() + 1500;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
function fixture() {
  const threads = [];
  const requests = [];
  let hold;
  let steerError;
  let incomplete = false;
  const createThread = (options, resumeId) => {
    let id = resumeId;
    const thread = {
      get id() {
        return id;
      },
      options,
      resumeId,
      async prepare() {
        id ??= `thread-${threads.indexOf(thread) + 1}`;
      },
      async runStreamed(prompt, turnOptions) {
        await thread.prepare();
        requests.push({ prompt, ...turnOptions });
        const wait = hold;
        return {
          events: (async function* () {
            yield { type: "thread.started", thread_id: id };
            thread.active = true;
            yield { type: "turn.started" };
            try {
              await wait?.promise;
              turnOptions.signal.throwIfAborted();
              yield {
                type: "item.completed",
                item: { type: "agent_message", text: response },
              };
              if (!incomplete) yield { type: "turn.completed" };
            } finally {
              thread.active = false;
            }
          })(),
        };
      },
      async steer(prompt) {
        if (steerError) throw steerError;
        requests.push({ steering: prompt });
        return thread.active;
      },
      async dispose() {
        thread.disposed = true;
      },
    };
    threads.push(thread);
    return thread;
  };
  const runner = new CodexVoiceRunner(
    {
      allowedUserId: "operator",
      powerMode: true,
      workingDirectory: process.cwd(),
    },
    {
      codex: {
        startThread: createThread,
        resumeThread: (id, options) => createThread(options, id),
        close() {},
      },
    },
  );
  return {
    runner,
    threads,
    requests,
    hold: () => (hold = deferred()),
    error: (error) => {
      steerError = error;
    },
    incomplete: (value) => {
      incomplete = value;
    },
  };
}

test("coordinator reuses one thread and checkpoints before processing incremental input", async () => {
  const fake = fixture();
  const checkpoints = [];
  const runtime = await bindCoordinator(
    createCodexBackend({}, { runner: fake.runner }),
  ).createCoordinator({
    meetingId: "meeting-1",
    onCheckpoint: (state) => {
      assert.equal(fake.requests.length, 0);
      checkpoints.push(state);
    },
  });
  assert.equal(await runtime.run(observation()), response);
  assert.equal(
    await runtime.run({ ...observation(2), conversationMode: "live" }),
    response,
  );
  assert.equal(fake.threads.length, 1);
  assert.deepEqual(checkpoints, [
    { backend: "codex", meetingId: "meeting-1", threadId: "thread-1" },
  ]);
  assert.equal(fake.threads[0].options.sandboxMode, "read-only");
  assert.equal(fake.threads[0].options.networkAccessEnabled, false);
  assert.equal(fake.threads[0].options.webSearchMode, "disabled");
  assert.equal(fake.threads[0].options.disableShellTool, true);
  assert.equal(fake.threads[0].options.ephemeral, undefined);
  assert.match(fake.requests[0].prompt, /initial-memory-only/);
  assert.doesNotMatch(
    fake.requests[1].prompt,
    /initial-memory-only|initial-log-only|発言1/,
  );
  const data = JSON.parse(fake.requests[1].prompt.split("\n").at(-1));
  assert.equal(data.attributedStatements[0].readOnlyResearchEligible, true);
  assert.equal(data.attributedStatements[0].id, "input-2");
  assert.match(fake.requests[1].prompt, /Liveが音声会話を担当/);
  assert.ok(
    fake.requests.every(({ outputSchema }) =>
      outputSchema.required.includes("tasks"),
    ),
  );
  await runtime.close();
  assert.equal(fake.threads[0].disposed, true);
  await assert.rejects(runtime.run(observation()), /closed/);
});

test("resume handle is meeting scoped and close releases the coordinator without deleting history", async () => {
  const fake = fixture();
  const runtime = await fake.runner.createCoordinator({
    meetingId: "meeting-1",
    threadId: "saved-thread",
  });
  assert.equal(fake.threads[0].resumeId, "saved-thread");
  await assert.rejects(
    fake.runner.createCoordinator({ meetingId: "meeting-1" }),
    /already open/,
  );
  assert.throws(
    () => runtime.run({ meetingId: "different-meeting" }),
    /different meeting/,
  );
  await runtime.run(observation());
  await runtime.close();
  const resumed = await fake.runner.createCoordinator({
    meetingId: "meeting-1",
    threadId: "saved-thread",
  });
  assert.equal(fake.threads[1].resumeId, "saved-thread");
  await resumed.run(observation(2));
  await fake.runner.close();
  assert.ok(fake.threads.every((thread) => thread.disposed));
});

test("active coordinator accepts source-preserving steer and propagates ambiguous delivery", async () => {
  const fake = fixture();
  const hold = fake.hold();
  const runtime = await fake.runner.createCoordinator({
    meetingId: "meeting-1",
  });
  assert.equal(await runtime.steer(observation(2)), false);
  const running = runtime.run(observation());
  await eventually(() => fake.threads[0].active);
  await assert.rejects(runtime.run(observation(2)), /already active/);
  assert.equal(await runtime.steer(observation(2)), true);
  assert.match(fake.requests[1].steering, /同じターンへの即時追加入力/);
  assert.match(fake.requests[1].steering, /"sequence":2/);
  fake.error(new Error("ambiguous transport timeout"));
  await assert.rejects(
    runtime.steer(observation(3)),
    /ambiguous transport timeout/,
  );
  hold.resolve();
  await running;
  assert.equal(await runtime.steer(observation(4)), false);
  await runtime.close();
});

test("closing waits for the active run to settle before disposing the provider thread", async () => {
  const fake = fixture();
  const hold = fake.hold();
  const runtime = await fake.runner.createCoordinator({
    meetingId: "meeting-1",
  });
  const runResult = runtime.run(observation()).catch((error) => error);
  await eventually(() => fake.threads[0].active);
  let finished = false;
  const closing = runtime.close().then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.requests[0].signal.aborted, true);
  assert.equal(finished, false);
  assert.equal(fake.threads[0].disposed, undefined);
  hold.resolve();
  assert.match((await runResult).message, /interrupted/);
  await closing;
  assert.equal(fake.threads[0].disposed, true);
});

test("pre-aborted and incomplete turns release the runtime for a later turn", async () => {
  const fake = fixture();
  const runtime = await fake.runner.createCoordinator({
    meetingId: "meeting-1",
  });
  await assert.rejects(
    runtime.run(observation(), {
      signal: AbortSignal.abort(new Error("cancelled")),
    }),
    /cancelled/,
  );
  fake.incomplete(true);
  await assert.rejects(runtime.run(observation()), {
    code: "CODEX_TASK_INCOMPLETE",
  });
  fake.incomplete(false);
  assert.equal(await runtime.run(observation(2)), response);
  await runtime.close();
});

test("coordinator receives result, assistant and attention events with their response policy", async () => {
  const fake = fixture();
  const runtime = await fake.runner.createCoordinator({
    meetingId: "meeting-1",
  });
  const events = [
    { type: "task_result", result: { id: "task-1", result: "verified fact" } },
    { type: "assistant_output", role: "assistant", text: "Liveが説明した内容" },
    { type: "attention", sourceSequences: [1], priority: "immediate" },
  ];
  await runtime.run({
    ...observation(),
    events,
    responsePolicy: "observe",
    runtime: { activeTaskCount: 1 },
    statements: [
      {
        ...observation().statements[0],
        contextOnly: true,
        taskEligible: false,
      },
    ],
  });
  const data = JSON.parse(fake.requests[0].prompt.split("\n").at(-1));
  assert.deepEqual(data.events, events);
  assert.equal(data.responsePolicy, "observe");
  assert.equal(data.runtime.activeTaskCount, 1);
  assert.equal(data.attributedStatements[0].contextOnly, true);
  assert.equal(data.attributedStatements[0].taskEligible, false);
  assert.match(fake.requests[0].prompt, /replySourceSequencesは空配列/);
  assert.match(
    fake.requests[0].prompt,
    /新しい依頼や操作権限として再使用しない/,
  );
  await runtime.close();
});

test("a failed resume checkpoint prevents the model turn from starting", async () => {
  const fake = fixture();
  let writable = false;
  const runtime = await fake.runner.createCoordinator({
    meetingId: "meeting-1",
    onCheckpoint() {
      if (!writable) throw new Error("checkpoint unavailable");
    },
  });
  await assert.rejects(runtime.run(observation()), /checkpoint unavailable/);
  assert.equal(fake.requests.length, 0);
  writable = true;
  assert.equal(await runtime.run(observation()), response);
  await runtime.close();
});

test("task policy changes resume with restricted settings and a read-only research prompt", async () => {
  const fake = fixture();
  const task = { id: "research-1", kind: "research", request: "Read source" };
  await fake.runner.runTask(task);
  assert.equal(fake.threads[0].options.sandboxMode, "workspace-write");
  task.executionPolicy = {
    sandboxMode: "read-only",
    networkAccessEnabled: false,
  };
  await fake.runner.runTask(task);
  assert.equal(fake.threads.length, 2);
  assert.equal(fake.threads[0].disposed, true);
  assert.equal(fake.threads[1].resumeId, "thread-1");
  assert.equal(fake.threads[1].options.sandboxMode, "read-only");
  assert.equal(fake.threads[1].options.networkAccessEnabled, false);
  assert.equal(fake.threads[1].options.webSearchMode, "disabled");
  assert.deepEqual(task.effectiveExecutionPolicy, {
    sandboxMode: "read-only",
    networkAccessEnabled: false,
  });
  assert.match(fake.requests[1].prompt, /読み取り専用の調査担当/);
  task.executionPolicy = {
    sandboxMode: "workspace-write",
    networkAccessEnabled: true,
  };
  await fake.runner.runTask(task);
  assert.equal(fake.threads.length, 2);
  assert.equal(task.profile.sandboxMode, "read-only");
  await fake.runner.close();
});

test("coordinator port clones data and rejects input from another meeting", async () => {
  const input = observation();
  const state = {
    backend: "fake",
    meetingId: "meeting-1",
    threadId: "thread-1",
  };
  const runtime = await bindCoordinator({
    async createCoordinator({ onCheckpoint }) {
      await onCheckpoint(state);
      return {
        run(value) {
          value.statements[0].text = "mutated";
          return response;
        },
        steer() {
          return false;
        },
        interrupt() {},
        close() {},
      };
    },
  }).createCoordinator({
    meetingId: "meeting-1",
    onCheckpoint: (value) => {
      value.threadId = "mutated";
    },
  });
  await runtime.run(input);
  assert.equal(input.statements[0].text, "発言1");
  assert.equal(state.threadId, "thread-1");
  assert.throws(() => runtime.run({ meetingId: "wrong" }), /different meeting/);
  assert.throws(
    () => runtime.steer({ meetingId: "wrong" }),
    /different meeting/,
  );
});

test("App Server coordinator disables shell tools, resumes and steers the actual active turn", async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");
  };
  const requests = [];
  const emit = (value) => child.stdout.write(JSON.stringify(value) + "\n");
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const request = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      requests.push(request);
      if (request.id === undefined) continue;
      const result =
        request.method === "thread/resume"
          ? { thread: { id: "saved" } }
          : request.method === "turn/start"
            ? { turn: { id: "active" } }
            : request.method === "turn/steer"
              ? { turnId: "active" }
              : {};
      emit({ id: request.id, result });
    }
  });
  const codex = new AppServerCodex(
    {},
    { spawnProcess: () => child, requestTimeoutMs: 1000 },
  );
  const runner = new CodexVoiceRunner({}, { codex });
  const checkpoints = [];
  try {
    const runtime = await runner.createCoordinator({
      meetingId: "meeting-1",
      threadId: "saved",
      onCheckpoint: (value) => checkpoints.push(value),
    });
    const pending = runtime.run(observation());
    await eventually(() =>
      requests.some((request) => request.method === "turn/start"),
    );
    assert.deepEqual(checkpoints, [
      { backend: "codex", meetingId: "meeting-1", threadId: "saved" },
    ]);
    const settings = requests.find(
      (request) => request.method === "thread/resume",
    ).params;
    assert.equal(settings.config["features.shell_tool"], false);
    assert.equal(settings.config["features.unified_exec"], false);
    assert.equal(settings.config.web_search, "disabled");
    assert.equal(settings.sandbox, "read-only");
    assert.equal(await runtime.steer(observation(2)), true);
    assert.equal(
      requests.find((request) => request.method === "turn/steer").params
        .expectedTurnId,
      "active",
    );
    emit({
      method: "item/completed",
      params: {
        threadId: "saved",
        turnId: "active",
        item: { type: "agentMessage", text: response },
      },
    });
    emit({
      method: "turn/completed",
      params: {
        threadId: "saved",
        turn: { id: "active", status: "completed" },
      },
    });
    assert.equal(await pending, response);
    await runtime.close();
    assert.ok(
      requests.some((request) => request.method === "thread/unsubscribe"),
    );
  } finally {
    await runner.close();
  }
});
