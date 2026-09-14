import assert from "node:assert/strict";
import test from "node:test";
import { createConversationEngine } from "../src/engine/conversation.mjs";
import { normalizeInput } from "../src/engine/input/port.mjs";
import { normalizeOutput } from "../src/engine/output/port.mjs";
import { bindExecution } from "../src/execution/port.mjs";
import { createCodexBackend } from "../src/execution/codex/backend.mjs";
import { discordPresentation } from "../src/adapters/discord/presentation.mjs";

const logger = { info() {} };
const config = {
  voiceMode: "meeting",
  allowedUserId: "operator",
  stageTimeouts: { running_codex: 1000 },
  observationIntervalMs: 60_000,
};
async function eventually(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function close(engine) {
  await Promise.all([engine.session.stop(), engine.taskQueue?.stop()]);
}

test("text and audio inputs preserve identity and use independent text-only output", async () => {
  let stt = 0,
    tts = 0,
    playback = 0;
  const posts = [],
    archived = [];
  const engine = await createConversationEngine({
    config,
    audio: {
      transcribe: async () => {
        stt++;
        return "音声入力";
      },
      synthesize: async () => {
        tts++;
      },
    },
    execution: {
      observeMeeting: async () =>
        JSON.stringify({
          minutes: "要点",
          shouldReply: true,
          reply: "回答",
          replyReason: "new_finding",
          replySourceSequences: [1],
          tasks: [],
          taskControls: [],
        }),
    },
    output: {
      postText: async (text) => posts.push(text),
      playAudio: async () => {
        playback++;
      },
    },
    transcriptArchive: {
      append: async (statement) => archived.push(structuredClone(statement)),
      stop: async () => {},
    },
    logger,
  });
  try {
    await engine.input.accept({
      type: "text",
      id: "message-1",
      sessionId: engine.session.meetingId,
      actor: { id: "operator", name: "Operator" },
      text: "入力テキスト",
      metadata: {
        taskEligible: false,
        taskId: "task-1",
        requestKey: "request-1",
      },
    });
    assert.equal(stt, 0);
    assert.deepEqual(
      [
        archived[0].id,
        archived[0].userId,
        archived[0].taskId,
        archived[0].requestKey,
        archived[0].taskEligible,
      ],
      ["message-1", "operator", "task-1", "request-1", false],
    );
    engine.input.accept({
      type: "audio",
      id: "audio-1",
      audio: Buffer.from("fixture"),
      actor: { id: "operator" },
      metadata: { taskEligible: false },
    });
    await eventually(() => archived.length === 2);
    assert.equal(archived[1].id, "audio-1");
    assert.equal(archived[1].taskEligible, false);
    await engine.session.observeNow();
    await eventually(() => posts.includes("回答"));
    assert.equal(stt, 1);
    assert.equal(tts, 0);
    assert.equal(playback, 0);
    assert.doesNotMatch(posts.join("\n"), /<#|\/ido|\*\*/);
    assert.throws(
      () =>
        engine.input.accept({ type: "text", text: "old", sessionId: "other" }),
      /different meeting/,
    );
  } finally {
    await close(engine);
  }
});

test("direct turns accept text without STT and enable speech only when advertised", async () => {
  for (const enabled of [false, true]) {
    const calls = [];
    const engine = await createConversationEngine({
      config: { ...config, voiceMode: "turn" },
      audio: {
        transcribe: async () => assert.fail("text must bypass STT"),
        synthesize: async () => {
          calls.push("tts");
          return Buffer.from("pcm");
        },
      },
      execution: {
        run: async (text, options) => {
          assert.equal(options.metadata.userId, "operator");
          return text;
        },
      },
      output: {
        capabilities: { audio: enabled },
        postText: async () => calls.push("text"),
        playAudio: async () => calls.push("play"),
      },
      logger,
    });
    try {
      assert.equal(
        engine.input.accept({
          type: "text",
          text: "hello",
          actor: { id: "operator" },
        }),
        true,
      );
      await engine.session.processingOperation;
      assert.deepEqual(
        calls,
        enabled ? ["text", "text", "tts", "play"] : ["text", "text"],
      );
    } finally {
      await close(engine);
    }
  }
});

test("output capability validation and plain task surfaces do not require threads", async () => {
  assert.throws(() => normalizeOutput({}), /postText/);
  assert.throws(
    () => normalizeOutput({ postText() {}, capabilities: { audio: true } }),
    /playAudio/,
  );
  assert.throws(
    () => normalizeInput({ type: "audio", audio: "wrong" }),
    /Buffer/,
  );
  assert.throws(() => normalizeInput({ type: "unknown" }), /type/);
  const posts = [];
  const output = normalizeOutput({
    postText: async (text) => posts.push(text),
  });
  const surface = await output.createTaskThread({ id: "task-1" });
  await surface.post("result");
  assert.deepEqual(posts, ["result"]);
  assert.equal(
    (await output.restoreTaskSurface({ id: "task-1" })).threadId,
    surface.threadId,
  );
});

// This is a simulated delegating backend, not a production worker scheduler.
// It exercises the exact same port the single Codex implementation uses.
test("delegation correlates progress, continuation, cancellation, failure and restored execution handles", async () => {
  const calls = [],
    posts = [];
  const backend = {
    async runTask(request, { signal, onProgress, checkpoint }) {
      const agent =
        request.execution?.agent ??
        (request.id === "first" ? "agent-a" : "agent-b");
      const revision = (request.runRevision ?? 0) + 1;
      calls.push({
        id: request.id,
        agent,
        instruction: request.additionalInstruction,
        revision,
      });
      await checkpoint({
        execution: {
          backend: "mock-delegation",
          agent,
          handle: request.execution?.handle ?? `run:${request.id}`,
        },
        runRevision: revision,
      });
      await onProgress(`${agent}:${request.id}`);
      if (request.additionalInstruction === "fail")
        throw new Error("simulated worker failure");
      if (request.id === "second" && !request.additionalInstruction) {
        await new Promise((_, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
      return { text: `${agent}:${request.id}:done`, state: {} };
    },
  };
  const output = {
    capabilities: { tasks: true },
    postText: async (text) => posts.push(["main", text]),
    createTaskThread: async (task) => ({
      threadId: task.threadId ?? task.id,
      post: async (text) => posts.push([task.id, text]),
      update: async () => {},
    }),
    restoreTaskSurface: async (task) => output.createTaskThread(task),
  };
  const make = (initialState) =>
    createConversationEngine({
      config: { ...config, powerMode: true },
      output,
      execution: bindExecution(backend),
      initialState,
      logger,
    });
  let engine = await make();
  try {
    const queue = engine.taskQueue;
    await queue.enqueueDurable({
      id: "first",
      requestKey: "first-request",
      title: "first",
    });
    await queue.enqueueDurable({
      id: "second",
      requestKey: "second-request",
      title: "second",
    });
    await eventually(
      () =>
        queue.getTaskResult("first")?.currentState === "completed" &&
        calls.length === 2,
    );
    await queue.handleTaskMessageDurable({
      taskId: "first",
      userId: "operator",
      ownerUserId: "operator",
      content: "continue",
      requestKey: "follow-up",
    });
    await eventually(
      () =>
        calls.length === 3 &&
        queue.getTaskResult("first")?.currentState === "completed",
    );
    assert.deepEqual(calls[2], {
      id: "first",
      agent: "agent-a",
      instruction: "continue",
      revision: 2,
    });
    // Stop the service: the blocked task becomes interrupted and keeps its backend handle.
    await close(engine);
    const saved = queue.snapshot();
    assert.equal(
      saved.find((task) => task.id === "second").state,
      "interrupted",
    );
    engine = await make({ tasks: saved });
    assert.equal(calls.length, 3, "restore must not reexecute accepted tasks");
    assert.equal(
      await engine.taskQueue.enqueueDurable({
        id: "first",
        requestKey: "first-request",
        title: "first",
      }),
      true,
    );
    assert.equal(
      calls.length,
      3,
      "duplicate acceptance must not execute again",
    );
    await engine.taskQueue.handleTaskMessageDurable({
      taskId: "second",
      userId: "operator",
      ownerUserId: "operator",
      content: "fail",
      requestKey: "second-follow-up",
    });
    await eventually(
      () => engine.taskQueue.getTaskResult("second")?.currentState === "failed",
    );
    assert.equal(calls[3].agent, "agent-b");
    assert.equal(
      engine.taskQueue.snapshot().find((task) => task.id === "second").execution
        .handle,
      "run:second",
    );
    assert.ok(
      posts.some(([id, text]) => id === "first" && text === "agent-a:first"),
    );
    assert.ok(
      posts.some(([id, text]) => id === "second" && text === "agent-b:second"),
    );
    assert.ok(
      !posts.some(([id, text]) => id === "first" && text.includes("agent-b")),
    );
  } finally {
    await close(engine);
  }
});

test("single Codex backend contains SDK objects and checkpoints state on interruption", async () => {
  const checkpointed = [];
  const sdkThread = { id: "saved-thread", run() {} };
  const runner = {
    async runTask(task) {
      task.codexThread = sdkThread;
      task.codexThreadId = sdkThread.id;
      task.runRevision = 1;
      await task.checkpoint();
      throw new Error("interrupted");
    },
    async applyTask(task) {
      task.applied = true;
      return true;
    },
  };
  const port = bindExecution(createCodexBackend({}, { runner }));
  const task = {
    id: "task-1",
    codexThreadId: "legacy-thread",
    checkpoint: async () => checkpointed.push(task.execution),
  };
  await assert.rejects(() => port.runTask(task), /interrupted/);
  assert.equal(task.codexThread, undefined);
  assert.equal(task.execution.threadId, "saved-thread");
  assert.ok(checkpointed.length > 0);
  structuredClone(task.execution);
  assert.equal(await port.applyTask(task), true);
  assert.equal(task.applied, true);
});

test("Discord presentation keeps durable delivery chunking and references", () => {
  const chunks = discordPresentation.splitText("あ".repeat(4000));
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [1900, 1900, 200],
  );
  assert.match(
    discordPresentation.meetingResult(
      { id: "task", title: "hello", threadId: "123", result: "done" },
      false,
    ),
    /詳細: <#123>/,
  );
});

test("normalized audio and text requests reach execution and plain results with authorization intact", async () => {
  for (const type of ["audio", "text"]) {
    const requests = [],
      posts = [];
    const engine = await createConversationEngine({
      config: { ...config, powerMode: true },
      audio: { transcribe: async () => "井戸Bot、実装してください" },
      execution: bindExecution({
        observeMeeting: async ({ statements }) =>
          JSON.stringify({
            minutes: "作業依頼",
            shouldReply: false,
            reply: "",
            taskControls: [],
            tasks: [
              {
                title: "作業",
                kind: "implementation",
                complexity: "routine",
                executionIntent: "requested",
                authorizationSequences: statements.map(
                  (statement) => statement.sequence,
                ),
                sourceSequences: statements.map(
                  (statement) => statement.sequence,
                ),
              },
            ],
          }),
        runTask: async (request) => {
          requests.push(request);
          return { text: "実行結果", state: { runRevision: 1 } };
        },
      }),
      output: { postText: async (text) => posts.push(text) },
      logger,
    });
    try {
      await engine.input.accept({
        type,
        ...(type === "audio"
          ? { audio: Buffer.from("fixture") }
          : { text: "井戸Bot、実装してください" }),
        actor: { id: "operator" },
      });
      await eventually(() => engine.session.statements.length === 1);
      await engine.session.observeNow();
      await eventually(
        () => requests.length === 1 && posts.includes("実行結果"),
      );
      assert.equal(requests[0].meetingId, engine.session.meetingId);
      assert.ok(requests[0].requestKey);
      assert.match(requests[0].request, /実装してください/);
      assert.equal(requests[0].surface, undefined);
      assert.equal(requests[0].controller, undefined);
    } finally {
      await close(engine);
    }
  }
});

test("stopping one delegated task aborts only that execution", async () => {
  const signals = new Map();
  const backend = {
    runTask: async (request, { signal }) => {
      signals.set(request.id, signal);
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  };
  const engine = await createConversationEngine({
    config: { ...config, powerMode: true },
    execution: bindExecution(backend),
    output: { postText: async () => {} },
    logger,
  });
  try {
    await engine.taskQueue.enqueueDurable({ id: "one", title: "one" });
    await engine.taskQueue.enqueueDurable({ id: "two", title: "two" });
    await eventually(() => signals.size === 2);
    await engine.taskQueue.handleVoiceControlDurable({
      type: "stop",
      taskId: "one",
      requestKey: "stop-one",
    });
    assert.equal(signals.get("one").aborted, true);
    assert.equal(signals.get("two").aborted, false);
    await eventually(
      () => engine.taskQueue.getTaskResult("one").currentState === "cancelled",
    );
  } finally {
    await close(engine);
  }
});

test("active Codex steering crosses the data boundary without losing specification, model or usage state", async () => {
  let worker,
    finish,
    closed = false;
  const steering = [];
  const runner = {
    async runTask(task) {
      worker = task;
      task.runRevision = 1;
      task.profile = { model: "gpt-5.6-sol", modelReasoningEffort: "low" };
      task.codexThread = { id: "active-thread", steer: async () => true };
      task.codexThreadId = task.codexThread.id;
      await task.checkpoint();
      await task.flushSteering();
      await new Promise((resolve) => {
        finish = resolve;
      });
      task.usage = { input_tokens: 10, output_tokens: 5 };
      task.usageHistory = [{ runRevision: 1, usage: task.usage }];
      return "corrected result";
    },
    async steerTask(task, text) {
      assert.equal(task, worker);
      assert.equal(typeof task.codexThread.steer, "function");
      steering.push(text);
      return true;
    },
    async investigateQuestion(question) {
      return `evidence:${question.text}`;
    },
    async close() {
      closed = true;
    },
  };
  const port = bindExecution(createCodexBackend({}, { runner }));
  const engine = await createConversationEngine({
    config: { ...config, powerMode: true },
    execution: port,
    output: { postText: async () => {} },
    logger,
  });
  try {
    await engine.taskQueue.enqueueDurable({
      id: "steering",
      title: "task",
      request: "implement",
      specRevision: 1,
      modelSelection: { model: "gpt-5.6-sol", reasoning: "low" },
      sourceSequences: [1],
      sourceStatements: [{ sequence: 1, text: "implement" }],
      acceptanceCriteria: ["passes checks"],
    });
    await eventually(() => Boolean(finish));
    assert.deepEqual(worker.acceptanceCriteria, ["passes checks"]);
    assert.equal(worker.modelSelection.model, "gpt-5.6-sol");
    assert.equal(worker.activeSpecRevision, 1);
    for (const content of ["correct once", "correct twice"]) {
      await engine.taskQueue.handleTaskMessageDurable({
        taskId: "steering",
        userId: "operator",
        ownerUserId: "operator",
        content,
        requestKey: content,
      });
    }
    await eventually(() => steering.length === 2);
    finish();
    await eventually(
      () =>
        engine.taskQueue.getTaskResult("steering")?.currentState ===
        "completed",
    );
    const saved = engine.taskQueue.snapshot()[0];
    assert.equal(saved.activeSpecRevision, 3);
    assert.equal(saved.resultMetadata.specRevision, 3);
    assert.equal(saved.execution.threadId, "active-thread");
    assert.equal(saved.codexThread, undefined);
    assert.deepEqual(saved.usage, { input_tokens: 10, output_tokens: 5 });
    assert.equal(saved.usageHistory.length, 1);
    assert.equal(
      await port.steerTask({ id: "steering" }, "after completion"),
      false,
    );
    assert.equal(
      await port.investigateQuestion({ text: "why" }),
      "evidence:why",
    );
  } finally {
    finish?.();
    await close(engine);
    await port.close();
  }
  assert.equal(closed, true);
});
