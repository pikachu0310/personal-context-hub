import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  CoordinatorFactory,
  CoordinatorObservation,
  CoordinatorResponse,
} from "@ido/common/contracts/coordinator";
import type {
  ConversationInput,
  InputContext,
  PluginEvent,
  PluginOutput,
} from "@ido/common/contracts/plugins";
import type { Task } from "@ido/common/contracts/protocol";
import { Projects } from "../src/processing/projects/service.js";
import { Engine } from "../src/bootstrap/engine.js";
import type { Message } from "../src/domain/models.js";
import { wrapPcmAsWav } from "../src/input/audio/signal.mjs";

const silent = (): CoordinatorResponse => ({
  reply: null,
  tasks: [],
  controls: [],
});
const sourceIds = (observation: CoordinatorObservation) =>
  observation.events.flatMap((event) =>
    event.type === "message" ? [event.source.id] : [],
  );
const taskResponse = (
  observation: CoordinatorObservation,
  kind: CoordinatorResponse["tasks"][number]["kind"] = "research",
): CoordinatorResponse => ({
  ...silent(),
  tasks: [
    {
      title: "対象の調査",
      kind,
      sourceIds: sourceIds(observation),
      acceptanceCriteria: ["根拠を示す"],
    },
  ],
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(check: () => boolean) {
  const limit = Date.now() + 2500;
  while (Date.now() < limit) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Expected coordinated Engine state was not reached");
}
function audio() {
  const pcm = Buffer.alloc(38_400);
  for (let i = 0; i < pcm.length; i += 2)
    pcm.writeInt16LE(Math.round(1500 * Math.sin(i / 15)), i);
  return wrapPcmAsWav(pcm).toString("base64");
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ido-coordinated-engine-"));
  const calls: Array<{
    observation: CoordinatorObservation;
    gate: ReturnType<typeof deferred<CoordinatorResponse>>;
  }> = [];
  const steers: CoordinatorObservation[] = [],
    factories: any[] = [],
    runtimes: any[] = [];
  const delivered: PluginOutput[] = [],
    publications: PluginEvent[] = [],
    speech: string[] = [],
    live: any[] = [];
  const legacy: string[] = [];
  let respond: (
    observation: CoordinatorObservation,
  ) => CoordinatorResponse | undefined = silent;
  let transcribe: () => Promise<string> = async () => "音声の発言";
  let inputSequence = 0;
  const coordinator: CoordinatorFactory = {
    async createCoordinator(options) {
      factories.push({ meetingId: options.meetingId, handle: options.handle });
      let active: (typeof calls)[number] | undefined;
      const runtime = {
        closed: false,
        async run(
          observation: CoordinatorObservation,
          { signal }: { signal?: AbortSignal } = {},
        ) {
          if (runtime.closed) throw new Error("FIXTURE_CLOSED");
          const call = {
            observation: structuredClone(observation),
            gate: deferred<CoordinatorResponse>(),
          };
          calls.push(call);
          active = call;
          const abort = () => call.gate.reject(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          try {
            await options.onCheckpoint?.(
              options.handle ?? {
                backend: "fixture",
                meetingId: options.meetingId,
                threadId: `thread-${factories.length}`,
              },
            );
            const result = respond(observation);
            if (result) call.gate.resolve(result);
            return await call.gate.promise;
          } finally {
            signal?.removeEventListener("abort", abort);
            active = undefined;
          }
        },
        async steer(observation: CoordinatorObservation) {
          if (!active) return false;
          steers.push(structuredClone(observation));
          return true;
        },
        async interrupt() {
          active?.gate.reject(new Error("FIXTURE_INTERRUPTED"));
        },
        async close() {
          runtime.closed = true;
          await runtime.interrupt();
        },
      };
      runtimes.push(runtime);
      return runtime;
    },
  };
  const create = () => {
    const engine = new Engine({
      directory,
      conversation: {
        coordinator,
        observationIntervalMs: 60_000,
        createLiveSession: async (options: any) => {
          const session = {
            ready: false,
            closed: false,
            comments: [] as string[],
            statements: [] as any[],
            frames: [] as string[],
            options,
            async start() {
              session.ready = true;
            },
            input(actor: string) {
              session.frames.push(actor);
            },
            speakerStart() {},
            speakerEnd() {},
            recordStatement(value: any) {
              session.statements.push(structuredClone(value));
            },
            commentary(text: string) {
              session.comments.push(text);
              options.output.append(Buffer.alloc(960));
            },
            silence() {},
            resume() {},
            close() {
              session.closed = true;
              session.ready = false;
            },
          };
          live.push(session);
          return session;
        },
      },
    });
    engine.plugins.publish = (event) => {
      publications.push(structuredClone(event));
    };
    engine.conversation.models.answer = async () => {
      legacy.push("answer");
      throw new Error("LEGACY_ANSWER");
    };
    engine.conversation.models.update = async () => {
      legacy.push("update");
      throw new Error("LEGACY_UPDATE");
    };
    engine.conversation.models.transcribe = () => transcribe();
    engine.conversation.models.speak = async (text) => {
      speech.push(text);
      return "fixture-audio";
    };
    return engine;
  };
  let engine = create(),
    closed = false;
  engine.store.put("project", "project", {
    id: "project",
    name: "Project",
    remote: "",
  });
  engine.store.put("meeting", "meeting", {
    id: "meeting",
    name: "Meeting",
    projectId: "project",
    summary: "",
    messages: [],
  });
  for (const [id, name, role] of [
    ["speaker-a", "話者A", "member"],
    ["speaker-b", "話者B", "member"],
    ["viewer", "閲覧者", "viewer"],
  ])
    engine.store.put("participant", id, { id, name, role });
  const close = async () => {
    if (!closed) {
      closed = true;
      await engine.close();
    }
  };
  t.after(async () => {
    await close();
    assert.deepEqual(legacy, []);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const context = (actorId = "speaker-a") => {
    const access = { valid: true };
    const value: InputContext = {
      pluginId: "fixture",
      actor: engine.store.conversationAuthor(actorId)!,
      valid: () => access.valid,
      deliver: async (output) => {
        delivered.push(structuredClone(output));
      },
      publish: (event) => {
        publications.push(structuredClone(event));
      },
    };
    return { access, value };
  };
  return {
    get engine() {
      return engine;
    },
    get core() {
      return engine.conversation.coordinated!;
    },
    calls,
    steers,
    factories,
    runtimes,
    delivered,
    publications,
    speech,
    live,
    context,
    respond(handler: typeof respond) {
      respond = handler;
    },
    transcribe(handler: typeof transcribe) {
      transcribe = handler;
    },
    tasks: () => engine.store.list<Task>("task"),
    messages: () => engine.store.list<Message>("message"),
    async idle() {
      await until(
        () => !engine.conversation.coordinated!.state("meeting").busy,
      );
    },
    async input(event: Partial<ConversationInput> = {}, ctx = context().value) {
      await engine.input.handle(
        {
          eventId: `input-${++inputSequence}`,
          meetingId: "meeting",
          projectId: "project",
          ...event,
        },
        ctx,
      );
    },
    async restart() {
      await close();
      engine = create();
      closed = false;
    },
    close,
  };
}

test("InputRouter keeps raw statements separate from minutes and one main thread receives only new messages", async (t) => {
  const f = await fixture(t);
  await f.input({ text: "前提の一つ目", eventId: "first" });
  assert.equal(f.calls.length, 0);
  await f.core.flush("meeting");
  await f.idle();
  await f.input(
    { text: "前提の二つ目", eventId: "second" },
    f.context("speaker-b").value,
  );
  await f.core.flush("meeting");
  await f.idle();
  assert.equal(f.factories.length, 1);
  assert.deepEqual(
    f.calls.map((call) =>
      call.observation.events.flatMap((event) =>
        event.type === "message" ? [event.source.text] : [],
      ),
    ),
    [["前提の一つ目"], ["前提の二つ目"]],
  );
  const meeting = f.engine.store.get<any>("meeting", "meeting");
  assert.equal(meeting.summary, "");
  assert.deepEqual(
    meeting.messages.map((message: Message) => [
      message.authorName,
      message.text,
    ]),
    [
      ["話者A", "前提の一つ目"],
      ["話者B", "前提の二つ目"],
    ],
  );
  assert.equal(f.tasks().length, 0);
});

test("a polite spoken request creates work and immediately acknowledges the actual accepted task", async (t) => {
  const f = await fixture(t);
  f.respond((observation) => taskResponse(observation, "implementation"));
  await f.input({
    text: "井戸Bot、検索画面のモックを作ってくれるかな？",
    priority: "immediate",
  });
  await f.idle();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.tasks()[0].trigger, "requested");
  assert.equal(
    f.delivered.filter(
      (output) =>
        output.kind === "reply" && output.content?.includes("受け付けました"),
    ).length,
    1,
  );
});

test("unaddressed concrete opportunities create bounded work, repeated discussion does not proliferate, and explicit requests bypass automatic cooldown", async (t) => {
  const f = await fixture(t);
  let title = "検索画面の比較モック";
  f.respond((observation) => ({
    ...silent(),
    tasks: [{ ...taskResponse(observation, "implementation").tasks[0], title }],
  }));
  await f.input({
    text: "検索画面は小さな比較モックがあると判断しやすいね。",
    priority: "normal",
  });
  await f.core.flush("meeting");
  await f.idle();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.tasks()[0].trigger, "proactive");
  await f.input({
    text: "そうだね、検索画面の比較モックで見たい。",
    priority: "normal",
  });
  await f.core.flush("meeting");
  await f.idle();
  assert.equal(f.tasks().length, 1);
  title = "音声接続の遅延調査";
  await f.input({
    text: "音声接続の遅延も原因を調査できるといいね。",
    priority: "normal",
  });
  await f.core.flush("meeting");
  await f.idle();
  assert.equal(f.tasks().length, 1);
  await f.input({
    text: "井戸Bot、音声接続の遅延の原因を調べてください。",
    priority: "immediate",
  });
  await f.idle();
  assert.equal(f.tasks().length, 2);
  assert.equal(f.tasks()[1].trigger, "requested");
});

test("a requested outcome can cite a teammate's relevant statement without attributing the request to that teammate", async (t) => {
  const f = await fixture(t);
  f.respond((observation) => taskResponse(observation, "implementation"));
  await f.input({
    text: "検索は一覧から絞り込むモックにしたい。",
    priority: "normal",
  });
  await f.input(
    { text: "井戸Bot、その検索モックを作ってください。", priority: "normal" },
    f.context("speaker-b").value,
  );
  await f.core.flush("meeting");
  await f.idle();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.tasks()[0].authorId, "speaker-b");
  assert.equal(f.tasks()[0].sourceStatements?.length, 2);
});

test("automatic topic minutes are published and keep raw speaker statements as citations", async (t) => {
  const f = await fixture(t);
  f.respond((observation) => ({
    ...silent(),
    minutes: [
      {
        meetingId: "meeting",
        topics: [
          {
            id: null,
            title: "検索方式",
            summary: "一覧から絞り込む方式を採用する。速度は未確認。",
            decisions: ["一覧から絞り込む"],
            openQuestions: ["検索速度"],
            sourceIds: sourceIds(observation),
          },
        ],
      },
    ],
  }));
  await f.input({
    text: "一覧からの絞り込みに決定。検索速度は後で測ろう。",
    priority: "normal",
  });
  await f.core.flush("meeting");
  await f.idle();
  const meeting = f.engine.store.get<any>("meeting", "meeting");
  assert.equal(meeting.knowledge.topics.length, 1);
  assert.equal(meeting.knowledge.topics[0].sourceIds[0], f.messages()[0].id);
  assert.equal(
    f.messages()[0].text,
    "一覧からの絞り込みに決定。検索速度は後で測ろう。",
  );
  assert.ok(
    f.publications.some(
      (event) =>
        event.type === "minutes" &&
        (event.data as any).knowledge?.topics.length,
    ),
  );
  assert.equal(f.tasks().length, 0);
});

for (const liveMode of [false, true])
  test(`attributed STT research and native worker results return through main to ${liveMode ? "Live" : "TTS"}`, async (t) => {
    const f = await fixture(t);
    if (liveMode) await f.core.setMode("meeting", "live");
    f.transcribe(async () => "この値がソースのどこで決まるか教えてください");
    f.respond((observation) =>
      observation.events.some((event) => event.type === "task_result")
        ? {
            ...silent(),
            reply: {
              text: "確認できた結果を説明します。",
              reason: "new_finding",
              sourceIds: [],
            },
          }
        : taskResponse(observation),
    );
    await f.input({
      audio: audio(),
      command: "ask",
      capture: {
        sessionId: "voice",
        utteranceId: "utterance",
        segmentIndex: 0,
        startedAt: 100,
        complete: true,
        final: true,
      },
    });
    await until(() => f.tasks().length === 1);
    await f.idle();
    const [task] = f.tasks();
    assert.equal(task.authorId, "speaker-a");
    assert.equal(task.projectId, "project");
    assert.equal(task.executionPolicy?.sandboxMode, "read-only");
    assert.deepEqual(task.sourceIds, sourceIds(f.calls[0].observation));
    assert.equal(f.messages()[0].authorName, "話者A");
    const workerOwner = f.engine.store.createUser(
      "worker-owner",
      "fixture-password-long",
      "member",
    );
    f.engine.store.put("device", "worker", {
      id: "worker",
      userId: workerOwner.id,
      name: "Worker",
      publicKey: "fixture",
      revoked: false,
      codexConnected: true,
      generation: 1,
      grants: [{ projectId: "project", network: false, slots: 1 }],
      slots: 1,
      lastAssigned: 0,
      executionPolicyVersion: 1,
    });
    f.engine.ready.add("worker");
    f.engine.flush();
    const assigned = f.tasks()[0];
    assert.equal(assigned.clientId, "worker");
    assert.equal(
      f.engine.tasks.updateResult("worker", 1, {
        v: 1,
        type: "result",
        taskId: assigned.id,
        runId: assigned.runId,
        revision: assigned.revision,
        specRevision: assigned.specRevision,
        state: "completed",
        result: "ワーカーが実物で確認した結果",
      }),
      true,
    );
    f.engine.flush();
    await until(() => f.calls.length === 2);
    await f.idle();
    await until(() =>
      f.delivered.some(
        (output) => output.kind === (liveMode ? "audio-frame" : "audio"),
      ),
    );
    assert.equal(f.calls[1].observation.events[0].type, "task_result");
    assert.equal(
      f.calls[1].observation.events[0].type === "task_result" &&
        f.calls[1].observation.events[0].text,
      "ワーカーが実物で確認した結果",
    );
    assert.equal(
      f.delivered.filter(
        (output) => output.content === "確認できた結果を説明します。",
      ).length,
      1,
    );
    assert.deepEqual(
      f.speech,
      liveMode
        ? []
        : [
            "タスク「対象の調査」を受け付けました。実行先の空き・許可を待っています。",
            "確認できた結果を説明します。",
          ],
    );
    if (liveMode)
      assert.deepEqual(f.live[0].comments, [
        "タスク「対象の調査」を受け付けました。実行先の空き・許可を待っています。",
        "確認できた結果を説明します。",
      ]);
    f.engine.flush();
    await f.core.flush("meeting");
    assert.equal(f.calls.length, 2);
  });

test("parallel STT preserves both speakers and capture times when the second transcription finishes first", async (t) => {
  const f = await fixture(t);
  const first = deferred<string>();
  let count = 0;
  f.transcribe(() =>
    ++count === 1 ? first.promise : Promise.resolve("二人目の発言"),
  );
  const pending = f.input({
    audio: audio(),
    priority: "normal",
    capture: {
      sessionId: "voice",
      utteranceId: "one",
      segmentIndex: 0,
      startedAt: 100,
      complete: true,
      final: true,
    },
  });
  await until(() => count === 1);
  await f.input(
    {
      audio: audio(),
      priority: "normal",
      capture: {
        sessionId: "voice",
        utteranceId: "two",
        segmentIndex: 0,
        startedAt: 200,
        complete: true,
        final: true,
      },
    },
    f.context("speaker-b").value,
  );
  assert.equal(f.calls.length, 0);
  first.resolve("一人目の発言");
  await pending;
  await f.core.flush("meeting");
  await f.idle();
  const sources = f.calls[0].observation.events
    .flatMap((event) => (event.type === "message" ? [event.source] : []))
    .sort((a, b) => a.at - b.at);
  assert.deepEqual(
    sources.map(({ authorId, authorName, at, text }) => ({
      authorId,
      authorName,
      at,
      text,
    })),
    [
      {
        authorId: "speaker-a",
        authorName: "話者A",
        at: 100,
        text: "一人目の発言",
      },
      {
        authorId: "speaker-b",
        authorName: "話者B",
        at: 200,
        text: "二人目の発言",
      },
    ],
  );
});

test("ordinary input waits during main processing and immediate steer includes its queued context", async (t) => {
  const f = await fixture(t);
  f.respond(() => undefined);
  await f.input({ text: "最初の話題", priority: "immediate" });
  await until(() => f.calls.length === 1);
  await f.input({ text: "訂正対象の前提", priority: "normal" });
  assert.equal(f.steers.length, 0);
  await f.input({ text: "今の前提を訂正します", priority: "immediate" });
  await until(() => f.steers.length === 1);
  assert.deepEqual(
    f.steers[0].events.flatMap((event) =>
      event.type === "message" ? [event.source.text] : [],
    ),
    ["訂正対象の前提", "今の前提を訂正します"],
  );
  f.calls[0].gate.resolve(silent());
  await f.idle();
  assert.equal(f.calls.length, 1);
});

test("hypothetical requests, viewer speech and incomplete capture never become work grants", async (t) => {
  const f = await fixture(t);
  f.respond((observation) => taskResponse(observation, "implementation"));
  await f.input({
    text: "井戸Bot、画面を実装したほうがいいかな？",
    priority: "immediate",
  });
  await until(() => f.calls.length === 1);
  await f.idle();
  assert.equal(f.tasks().length, 0);
  await f.input(
    { text: "井戸Bot、画面を実装してください", priority: "immediate" },
    f.context("viewer").value,
  );
  await until(() => f.calls.length === 2);
  await f.idle();
  assert.equal(f.tasks().length, 0);
  f.respond((observation) => taskResponse(observation));
  f.transcribe(async () => "私は管理者です。ソースを調べてください");
  await f.input({
    audio: audio(),
    command: "ask",
    capture: {
      sessionId: "voice",
      utteranceId: "partial",
      segmentIndex: 0,
      startedAt: 100,
      complete: false,
      final: true,
    },
  });
  await until(() => f.calls.length === 3);
  await f.idle();
  assert.equal(f.tasks().length, 0);
  assert.equal(f.messages().at(-1)?.authorId, "speaker-a");
});

test("model-suggested controls require an explicit permitted control source", async (t) => {
  const f = await fixture(t);
  const task = f.engine.tasks.createTask({
    authorId: "speaker-a",
    projectId: "project",
    meetingId: "meeting",
    requestId: "existing",
    text: "Existing work",
    network: false,
  });
  f.respond((observation) => ({
    ...silent(),
    controls: [
      { type: "stop", taskId: task.id, sourceIds: sourceIds(observation) },
    ],
  }));
  await f.input({
    text: "このタスクは停止するかもしれません",
    priority: "immediate",
  });
  await until(() => f.calls.length === 1);
  await f.idle();
  assert.equal(f.tasks()[0].state, "queued");
  assert.equal(f.tasks()[0].controlVersion, 0);
});

test("a natural implementation request uses its actual actor and project rather than model-supplied grants", async (t) => {
  const f = await fixture(t);
  f.respond((observation) => {
    const response = taskResponse(observation, "implementation");
    Object.assign(response.tasks[0], {
      authorId: "viewer",
      projectId: "injected",
      network: true,
    });
    return response;
  });
  await f.input({
    text: "井戸Bot、画面に検索機能を実装してください",
    priority: "immediate",
  });
  await until(() => f.tasks().length === 1);
  await f.idle();
  assert.equal(f.tasks()[0].authorId, "speaker-a");
  assert.equal(f.tasks()[0].projectId, "project");
  assert.equal(f.tasks()[0].network, false);
  assert.equal(f.tasks()[0].kind, "implementation");
});

test("teammates can steer and stop a unique mock before the main model responds", async (t) => {
  const f = await fixture(t);
  f.respond(() => undefined);
  const task = f.engine.tasks.createTask({
    authorId: "speaker-a",
    projectId: "project",
    meetingId: "meeting",
    requestId: "mock",
    title: "検索画面のモック",
    text: "検索画面を作る",
    network: false,
  });
  await f.input(
    { text: "そのモックを青にして", priority: "normal" },
    f.context("speaker-b").value,
  );
  assert.match(f.tasks()[0].text, /青にして/u);
  assert.equal(f.tasks()[0].controlVersion, 1);
  assert.ok(
    f.delivered.some(
      (output) =>
        output.kind === "reply" &&
        /追加指示を受け付け/u.test(output.content ?? ""),
    ),
  );
  await f.input(
    { text: "そのモックを止めて", priority: "normal" },
    f.context("speaker-b").value,
  );
  assert.equal(f.tasks()[0].id, task.id);
  assert.equal(f.tasks()[0].state, "cancelled");
  assert.equal(f.calls.length, 0);
  assert.ok(
    f.delivered.some(
      (output) =>
        output.kind === "reply" && /停止しました/u.test(output.content ?? ""),
    ),
  );
});

test("ambiguous or quoted controls do not choose an arbitrary task", async (t) => {
  const f = await fixture(t);
  for (const requestId of ["one", "two"])
    f.engine.tasks.createTask({
      authorId: "speaker-a",
      projectId: "project",
      meetingId: "meeting",
      requestId,
      title: `${requestId}のモック`,
      text: requestId,
      network: false,
    });
  await f.input({ text: "そのモックを止めて", priority: "normal" });
  await f.input({
    text: "「そのモックを止めて」という文例です",
    priority: "normal",
  });
  assert.ok(
    f
      .tasks()
      .every((task) => task.state === "queued" && task.controlVersion === 0),
  );
  assert.ok(
    f.delivered.some(
      (output) => output.kind === "reply" && /複数/u.test(output.content ?? ""),
    ),
  );
});

for (const mismatch of ["target", "operation"] as const)
  test(`a natural stop request cannot authorize a model-changed ${mismatch}`, async (t) => {
    const f = await fixture(t);
    const [first, second] = ["first", "second"].map((requestId) =>
      f.engine.tasks.createTask({
        authorId: "speaker-a",
        projectId: "project",
        meetingId: "meeting",
        requestId,
        text: requestId,
        network: false,
      }),
    );
    f.respond((observation) => ({
      ...silent(),
      controls: [
        {
          type: mismatch === "target" ? "stop" : "instruction",
          taskId: mismatch === "target" ? second.id : first.id,
          sourceIds: sourceIds(observation),
        },
      ],
    }));
    await f.input({
      text: `井戸Bot、タスク ${first.id}を停止して`,
      priority: "immediate",
    });
    await until(() => f.calls.length === 1);
    await f.idle();
    assert.equal(
      f.tasks().find((task) => task.id === first.id)?.state,
      "cancelled",
    );
    assert.equal(
      f.tasks().find((task) => task.id === first.id)?.controlVersion,
      1,
    );
    assert.equal(
      f.tasks().find((task) => task.id === second.id)?.state,
      "queued",
    );
    assert.equal(
      f.tasks().find((task) => task.id === second.id)?.controlVersion,
      0,
    );
  });

test("a correctly sourced natural stop affects only the named task", async (t) => {
  const f = await fixture(t);
  const [first, second] = ["first", "second"].map((requestId) =>
    f.engine.tasks.createTask({
      authorId: "speaker-a",
      projectId: "project",
      meetingId: "meeting",
      requestId,
      text: requestId,
      network: false,
    }),
  );
  f.respond((observation) => ({
    ...silent(),
    controls: [
      { type: "stop", taskId: first.id, sourceIds: sourceIds(observation) },
    ],
  }));
  await f.input({
    text: `井戸Bot、タスク ${first.id}を停止して`,
    priority: "immediate",
  });
  await until(() => f.calls.length === 1);
  await f.idle();
  assert.equal(f.engine.store.get<Task>("task", first.id)?.state, "cancelled");
  assert.equal(f.engine.store.get<Task>("task", second.id)?.state, "queued");
});

test("permission changes while main runs invalidate its work proposal", async (t) => {
  const f = await fixture(t);
  f.respond(() => undefined);
  await f.input({
    text: "井戸Bot、ソースを調べてください",
    priority: "immediate",
  });
  await until(() => f.calls.length === 1);
  f.engine.store.put("participant", "speaker-a", {
    id: "speaker-a",
    name: "話者A",
    role: "viewer",
  });
  f.calls[0].gate.resolve(taskResponse(f.calls[0].observation));
  await f.idle();
  assert.equal(f.tasks().length, 0);
});

test("duplicate input and Live attention retain one authoritative source and one task", async (t) => {
  const f = await fixture(t);
  f.transcribe(async () => "井戸Bot、ソースを調べてください");
  f.respond((observation) =>
    sourceIds(observation).length
      ? taskResponse(observation)
      : {
          ...silent(),
          tasks: [
            {
              title: "Duplicated proposal",
              kind: "research",
              sourceIds: sourceIds(f.calls[0].observation),
              acceptanceCriteria: [],
            },
          ],
        },
  );
  const input = {
    eventId: "unique",
    audio: audio(),
    command: "ask" as const,
    capture: {
      sessionId: "voice",
      utteranceId: "source",
      segmentIndex: 0,
      startedAt: 100,
      complete: true,
      final: true,
    },
    priority: "immediate" as const,
  };
  await f.input(input);
  await until(() => f.tasks().length === 1);
  await f.idle();
  await f.input(input);
  assert.equal(f.messages().length, 1);
  await f.core.setMode("meeting", "live");
  assert.equal(
    f.live[0].statements[0].id,
    sourceIds(f.calls[0].observation)[0],
  );
  await f.live[0].options.onDelegation({
    delegation: { id: "delegation" },
    sourceIds: sourceIds(f.calls[0].observation),
  });
  await until(() => f.calls.length === 2);
  await f.idle();
  assert.equal(f.tasks().length, 1);
  await f.live[0].options.onDelegation({
    delegation: { id: "delegation" },
    sourceIds: sourceIds(f.calls[0].observation),
  });
  await f.core.flush("meeting");
  assert.equal(f.calls.length, 2);
});

test("Live keeps STT speaker records while the mode switch discards the old main answer", async (t) => {
  const f = await fixture(t);
  f.respond(() => undefined);
  f.transcribe(async () => "現在の値について質問します");
  await f.input(
    {
      audio: audio(),
      command: "ask",
      capture: {
        sessionId: "voice",
        utteranceId: "utterance",
        segmentIndex: 0,
        startedAt: 100,
        complete: true,
        final: true,
      },
    },
    f.context("speaker-b").value,
  );
  await until(() => f.calls.length === 1);
  await f.core.setMode("meeting", "live");
  assert.equal(f.live.length, 1);
  assert.equal(f.live[0].statements[0].userId, "speaker-b");
  f.calls[0].gate.resolve({
    ...silent(),
    reply: {
      text: "古い方式の回答",
      reason: "direct_answer",
      sourceIds: sourceIds(f.calls[0].observation),
    },
  });
  await f.idle();
  assert.ok(!f.delivered.some((output) => output.content === "古い方式の回答"));
  assert.equal(f.live[0].comments.length, 0);
  assert.equal(f.speech.length, 0);
  await f.live[0].options.onAssistantTranscript({
    id: "assistant-1",
    text: "Liveの実際の発言",
    startedAt: 200,
  });
  const flushing = f.core.flush("meeting");
  // The remaining observation is intentionally held by the fake model.
  await until(() => f.calls.length === 2);
  f.calls[1].gate.resolve(silent());
  await flushing;
  await f.idle();
  const output = f.engine.store
    .list<any>("conversation-output")
    .find((record) => record.provider === "live");
  assert.equal(output.role, "assistant");
  assert.equal(output.playbackStatus, "unknown");
  assert.equal(f.calls[1].observation.events[0].type, "assistant_output");
});

test("stopping and restoring an uncertain main turn does not automatically replay it", async (t) => {
  const f = await fixture(t);
  f.respond(() => undefined);
  await f.input({ text: "処理中の入力", priority: "immediate" });
  await until(() => f.calls.length === 1);
  await f.restart();
  assert.equal(f.runtimes[0].closed, true);
  assert.equal(f.core.state("meeting").uncertain, true);
  await f.core.flush("meeting");
  assert.equal(f.calls.length, 1);
  assert.equal(f.factories.length, 1);
});

test("Engine shutdown waits for pending STT routes before closing their store", async (t) => {
  const f = await fixture(t);
  const transcript = deferred<string>();
  let entered = false;
  f.transcribe(() => {
    entered = true;
    return transcript.promise;
  });
  const input = f.input({
    audio: audio(),
    capture: {
      sessionId: "voice",
      utteranceId: "pending",
      segmentIndex: 0,
      startedAt: 100,
      complete: true,
      final: true,
    },
  });
  const outcome = input.then(
    () => undefined,
    (error) => error,
  );
  await until(() => entered);
  let stopped = false;
  const closing = f.close().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const closedBeforeTranscription = stopped;
  transcript.resolve("停止中に完了した書き起こし");
  const error = await outcome;
  await closing;
  assert.equal(closedBeforeTranscription, false);
  assert.equal(error, undefined);
});

test("a result that becomes obsolete while main is answering cannot be announced as current", async (t) => {
  const f = await fixture(t);
  await f.input({ text: "この会議の結果を確認します" });
  await f.core.flush("meeting");
  await f.idle();
  const task = f.engine.tasks.createTask({
    authorId: "speaker-a",
    projectId: "project",
    meetingId: "meeting",
    requestId: "result",
    text: "Check source",
    network: false,
  });
  f.engine.store.put("task", task.id, {
    ...task,
    clientId: "fixture-worker",
    state: "completed",
    result: "以前の結果",
    resultSpecRevision: 1,
  });
  f.respond(() => undefined);
  f.engine.flush();
  await until(() => f.calls.length === 2);
  f.engine.tasks.control(task.id, "speaker-a", "retry");
  f.engine.flush();
  f.calls[1].gate.resolve({
    ...silent(),
    reply: {
      text: "以前の結果が現在も有効です",
      reason: "new_finding",
      sourceIds: [],
    },
  });
  await f.idle();
  assert.equal(f.engine.store.get<Task>("task", task.id)?.revision, 2);
  assert.ok(
    !f.delivered.some(
      (output) => output.content === "以前の結果が現在も有効です",
    ),
  );
});

test("a saved work response waits for authenticated resumption after restart instead of being consumed silently", async (t) => {
  const f = await fixture(t);
  f.respond((observation) => taskResponse(observation));
  const work = f.core.options.work;
  work.submit = () => {
    throw new Error("FIXTURE_WORK_TEMPORARILY_UNAVAILABLE");
  };
  await f.input({
    text: "井戸Bot、ソースを調べてください",
    priority: "immediate",
  });
  await until(() => f.calls.length === 1);
  await f.idle();
  assert.equal(
    f.core.session("meeting").inbox.snapshot().active.status,
    "response",
  );
  assert.equal(f.tasks().length, 0);
  await f.restart();
  await f.core.flush("meeting");
  await f.idle();
  assert.equal(f.tasks().length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.core.session("meeting").inbox.snapshot().active?.status,
    "response",
  );
  const ids = sourceIds(f.calls[0].observation);
  assert.deepEqual(
    f.core.state("meeting").awaitingSources,
    ids.map((id) => ({ id, authorId: "speaker-a" })),
  );
  await assert.rejects(
    f.core.resume("meeting", f.context("speaker-b").value, ids),
    /PERMISSION_DENIED/,
  );
  await assert.rejects(
    f.core.resume(
      "meeting",
      { ...f.context().value, pluginId: "different-plugin" },
      ids,
    ),
    /PERMISSION_DENIED/,
  );
  const revoked = f.context();
  revoked.access.valid = false;
  await assert.rejects(
    f.core.resume("meeting", revoked.value, ids),
    /PERMISSION_DENIED/,
  );
  assert.equal(f.tasks().length, 0);
  await f.core.resume("meeting", f.context().value, ids);
  await f.idle();
  assert.equal(f.tasks().length, 1);
  assert.equal(f.tasks()[0].authorId, "speaker-a");
  assert.equal(f.tasks()[0].executionPolicy?.sandboxMode, "read-only");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.core.state("meeting").awaitingSources, []);
});

test("unknown acknowledgement after text delivery never triggers an automatic duplicate send", async (t) => {
  const f = await fixture(t);
  let deliveries = 0;
  const context = f.context();
  context.value.deliver = async () => {
    deliveries++;
    throw new Error("FIXTURE_ACKNOWLEDGEMENT_LOST");
  };
  f.respond((observation) => ({
    ...silent(),
    reply: {
      text: "一度だけ配送する回答",
      reason: "direct_answer",
      sourceIds: sourceIds(observation),
    },
  }));
  await f.input(
    { text: "質問に答えてください", command: "ask" },
    context.value,
  );
  await until(() => deliveries === 1);
  await f.idle();
  await f.core.flush("meeting");
  await f.idle();
  await f.core.flush("meeting");
  await f.idle();
  assert.equal(f.calls.length, 1);
  assert.equal(deliveries, 1);
});

test("a task result invalidated during TTS synthesis is discarded before playback", async (t) => {
  const f = await fixture(t);
  await f.input({
    audio: audio(),
    priority: "normal",
    capture: {
      sessionId: "voice",
      utteranceId: "context",
      segmentIndex: 0,
      startedAt: 100,
      complete: true,
      final: true,
    },
  });
  await f.core.flush("meeting");
  await f.idle();
  const task = f.engine.tasks.createTask({
    authorId: "speaker-a",
    projectId: "project",
    meetingId: "meeting",
    requestId: "spoken-result",
    text: "Read source",
    network: false,
  });
  f.engine.store.put("task", task.id, {
    ...task,
    clientId: "fixture-worker",
    state: "completed",
    result: "以前の結果",
    resultSpecRevision: 1,
  });
  const synthesis = deferred<string>(),
    started = deferred<void>();
  let synthesisCount = 0;
  f.engine.conversation.models.speak = async (text) => {
    f.speech.push(text);
    if (++synthesisCount === 1) {
      started.resolve();
      return synthesis.promise;
    }
    return "fresh-audio";
  };
  f.respond(() => ({
    ...silent(),
    reply: { text: "最初の実行結果です", reason: "new_finding", sourceIds: [] },
  }));
  f.engine.flush();
  await started.promise;
  await f.idle();
  assert.equal(
    f.delivered.filter((output) => output.kind === "audio").length,
    0,
  );
  f.engine.tasks.control(task.id, "speaker-a", "retry");
  f.engine.flush();
  synthesis.resolve("obsolete-audio");
  // A following valid candidate waits behind the old candidate, without a new
  // input or cancellation that could hide a missing result-revision check.
  await f.core
    .session("meeting")
    .audio.reply({ text: "次の有効な案内", reason: "backend", events: [] });
  assert.deepEqual(
    f.delivered
      .filter((output) => output.kind === "audio")
      .map((output) => output.audio),
    ["fresh-audio"],
  );
});

test("large task histories and receipts cannot overflow the coordinator input budget", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 40; index++) {
    const task = f.engine.tasks.createTask({
      authorId: "speaker-a",
      projectId: "project",
      meetingId: "meeting",
      requestId: `large-${index}`,
      text: "長い作業内容".repeat(800),
      network: false,
    });
    const controlReceipts = Object.fromEntries(
      Array.from({ length: 12 }, (_, receipt) => [
        `receipt-${receipt}`,
        {
          id: `receipt-${index}-${receipt}`,
          taskId: task.id,
          authorId: "speaker-a",
          requestKey: `request-${receipt}`,
          type: "steer",
          controlVersion: receipt + 1,
          specRevision: receipt + 1,
          accepted: true,
          delivery: "queued",
          details: "DO_NOT_INJECT_RAW_RECEIPT".repeat(100),
        },
      ]),
    );
    f.engine.store.put("task", task.id, {
      ...task,
      state: "running",
      result: "長い確認結果".repeat(800),
      resultSpecRevision: 1,
      controlReceipts,
    });
  }
  await f.input({ text: "会議の入力".repeat(2000) });
  await f.core.flush("meeting");
  await f.idle();
  assert.equal(f.calls.length, 1);
  const payload = JSON.stringify(f.calls[0].observation);
  assert.ok(
    payload.length < 64_000,
    `Coordinator received ${payload.length} characters`,
  );
  assert.ok(f.calls[0].observation.activeTasks.length > 0);
  assert.ok(f.calls[0].observation.activeTasks.length < f.tasks().length);
  assert.ok(!payload.includes("DO_NOT_INJECT_RAW_RECEIPT"));
});

test("reverse STT completion joins a nonfinal incomplete piece and final complete piece into one work request", async (t) => {
  const f = await fixture(t);
  const first = deferred<string>();
  let count = 0;
  f.transcribe(() =>
    ++count === 1 ? first.promise : Promise.resolve("調べてください"),
  );
  f.respond((observation) => taskResponse(observation));
  const pending = f.input({
    eventId: "part-first",
    audio: audio(),
    command: "ask",
    capture: {
      sessionId: "voice",
      utteranceId: "long",
      segmentIndex: 0,
      startedAt: 100,
      complete: false,
      final: false,
    },
  });
  await until(() => count === 1);
  await f.input({
    eventId: "part-final",
    audio: audio(),
    command: "ask",
    capture: {
      sessionId: "voice",
      utteranceId: "long",
      segmentIndex: 1,
      startedAt: 200,
      complete: true,
      final: true,
    },
  });
  assert.equal(f.calls.length, 0);
  assert.equal(f.tasks().length, 0);
  first.resolve("井戸Bot、対象ソースを");
  await pending;
  await until(() => f.tasks().length === 1);
  await f.idle();
  const source = f.calls[0].observation.events.find(
    (event) => event.type === "message",
  );
  assert.equal(source?.type, "message");
  if (source?.type !== "message") assert.fail("Expected assembled source");
  assert.equal(source.source.text, "井戸Bot、対象ソースを\n調べてください");
  assert.equal(source.source.complete, true);
  assert.equal(source.source.at, 100);
  assert.deepEqual(
    f.messages().map(({ text, at }) => ({ text, at })),
    [
      { text: "井戸Bot、対象ソースを", at: 100 },
      { text: "調べてください", at: 200 },
    ],
  );
  assert.equal(f.tasks()[0].sourceStatements?.[0].text, source.source.text);
  assert.equal(f.tasks()[0].sourceStatements?.[0].startedAt, 100);
  assert.match(f.tasks()[0].text, /根拠を示す/);
  await f.core.flush("meeting");
  assert.equal(f.tasks().length, 1);
  assert.equal(f.calls.length, 1);
});

test("Dashboard plain chat delegates an explicit implementation request without a bot name", async (t) => {
  const f = await fixture(t);
  const user = f.engine.store.createUser(
    "dashboard",
    "fixture-password-long",
    "member",
  );
  const context = { ...f.context(user.id).value, pluginId: "dashboard" };
  f.respond((observation) => taskResponse(observation, "implementation"));
  await f.engine.workspace.request(
    "messages",
    {
      meetingId: "meeting",
      requestId: "dashboard-work",
      text: "検索機能を実装してください",
    },
    context,
  );
  await until(() => f.tasks().length === 1);
  await f.idle();
  assert.equal(f.tasks()[0].authorId, user.id);
  assert.equal(f.tasks()[0].projectId, "project");
  assert.equal(
    f.tasks()[0].sourceStatements?.[0].text,
    "検索機能を実装してください",
  );
  const event = f.calls[0].observation.events[0];
  assert.equal(event.type, "message");
  if (event.type === "message") {
    assert.equal(event.source.direct, true);
    assert.equal(event.source.requestReply, true);
  }
});

test("Dashboard plain questions receive a main-model answer without a wake word", async (t) => {
  const f = await fixture(t);
  const user = f.engine.store.createUser(
    "dashboard",
    "fixture-password-long",
    "member",
  );
  const context = { ...f.context(user.id).value, pluginId: "dashboard" };
  f.respond((observation) => ({
    ...silent(),
    reply: {
      text: "現在の構成を説明します。",
      reason: "direct_answer",
      sourceIds: sourceIds(observation),
    },
  }));
  await f.engine.workspace.request(
    "messages",
    {
      meetingId: "meeting",
      requestId: "dashboard-question",
      text: "現在の構成はどうなっていますか？",
    },
    context,
  );
  await until(() =>
    f.delivered.some((output) => output.content === "現在の構成を説明します。"),
  );
  await f.idle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.tasks().length, 0);
  assert.deepEqual(f.speech, []);
});

test("Dashboard direct interaction does not turn a hypothetical suggestion into work authorization", async (t) => {
  const f = await fixture(t);
  const user = f.engine.store.createUser(
    "dashboard",
    "fixture-password-long",
    "member",
  );
  const context = { ...f.context(user.id).value, pluginId: "dashboard" };
  f.respond((observation) => taskResponse(observation, "implementation"));
  await f.engine.workspace.request(
    "messages",
    {
      meetingId: "meeting",
      requestId: "dashboard-proposal",
      text: "検索機能を実装したほうがいいかな？",
    },
    context,
  );
  await until(() => f.calls.length === 1);
  await f.idle();
  const event = f.calls[0].observation.events[0];
  assert.equal(event.type === "message" && event.source.direct, true);
  assert.equal(f.tasks().length, 0);
});

test("Dashboard can explicitly queue an otherwise direct chat input as normal priority", async (t) => {
  const f = await fixture(t);
  const user = f.engine.store.createUser(
    "dashboard",
    "fixture-password-long",
    "member",
  );
  const context = { ...f.context(user.id).value, pluginId: "dashboard" };
  await f.engine.workspace.request(
    "messages",
    {
      meetingId: "meeting",
      requestId: "dashboard-queued",
      text: "次の処理でこの前提も確認してください",
      priority: "normal",
    },
    context,
  );
  await until(() => f.core.state("meeting").pending === 1);
  assert.equal(f.calls.length, 0);
  await f.core.flush("meeting");
  await f.idle();
  assert.equal(f.calls.length, 1);
});

test("an empty final STT piece completes the earlier recognized utterance exactly once", async (t) => {
  const f = await fixture(t);
  let count = 0;
  f.transcribe(async () =>
    ++count === 1 ? "井戸Bot、現在の構成を説明してください" : "",
  );
  await f.input({
    eventId: "recognized-piece",
    audio: audio(),
    command: "ask",
    capture: {
      sessionId: "voice",
      utteranceId: "tail-silence",
      segmentIndex: 0,
      startedAt: 100,
      complete: false,
      final: false,
    },
  });
  assert.equal(f.calls.length, 0);
  await f.input({
    eventId: "empty-final",
    audio: audio(),
    command: "ask",
    capture: {
      sessionId: "voice",
      utteranceId: "tail-silence",
      segmentIndex: 1,
      startedAt: 200,
      complete: true,
      final: true,
    },
  });
  await until(() => f.calls.length === 1);
  await f.idle();
  const event = f.calls[0].observation.events[0];
  assert.equal(event.type, "message");
  if (event.type === "message") {
    assert.equal(
      event.source.text.trim(),
      "井戸Bot、現在の構成を説明してください",
    );
    assert.equal(event.source.complete, true);
  }
  assert.equal(f.engine.store.list("speech-assembly").length, 0);
  await f.core.flush("meeting");
  assert.equal(f.calls.length, 1);
});

test("an all-silent captured utterance clears assembly without invoking the main model", async (t) => {
  const f = await fixture(t);
  f.transcribe(async () => {
    assert.fail("Silence must be rejected before the STT provider");
  });
  const silence = wrapPcmAsWav(Buffer.alloc(38_400)).toString("base64");
  for (const index of [0, 1])
    await f.input({
      eventId: `silence-${index}`,
      audio: silence,
      capture: {
        sessionId: "voice",
        utteranceId: "silence",
        segmentIndex: index,
        startedAt: 100 + index * 100,
        complete: index === 1,
        final: index === 1,
      },
    });
  await f.core.flush("meeting");
  assert.equal(f.calls.length, 0);
  assert.equal(f.tasks().length, 0);
  assert.equal(f.engine.store.list("speech-assembly").length, 0);
  assert.ok(
    f
      .messages()
      .every((message) => message.text === "" && message.stage === "ignored"),
  );
});

test("Live cannot announce an obsolete result after its text delivery was awaiting acknowledgement", async (t) => {
  const f = await fixture(t);
  const delivering = deferred<void>(),
    release = deferred<void>();
  const context = f.context();
  context.value.deliver = async (output) => {
    f.delivered.push(structuredClone(output));
    if (output.kind === "reply" && output.content === "最初の作業結果です") {
      delivering.resolve();
      await release.promise;
    }
  };
  await f.input(
    {
      audio: audio(),
      priority: "normal",
      capture: {
        sessionId: "voice",
        utteranceId: "context",
        segmentIndex: 0,
        startedAt: 100,
        complete: true,
        final: true,
      },
    },
    context.value,
  );
  await f.core.flush("meeting");
  await f.idle();
  await f.core.setMode("meeting", "live");
  const task = f.engine.tasks.createTask({
    authorId: "speaker-a",
    projectId: "project",
    meetingId: "meeting",
    requestId: "live-result",
    text: "Read source",
    network: false,
  });
  f.engine.store.put("task", task.id, {
    ...task,
    clientId: "fixture-worker",
    state: "completed",
    result: "以前の結果",
    resultSpecRevision: 1,
  });
  f.respond(() => ({
    ...silent(),
    reply: { text: "最初の作業結果です", reason: "new_finding", sourceIds: [] },
  }));
  f.engine.flush();
  await delivering.promise;
  f.engine.tasks.control(task.id, "speaker-a", "retry");
  f.engine.flush();
  release.resolve();
  await f.idle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    f.delivered.filter((output) => output.content === "最初の作業結果です")
      .length,
    1,
  );
  assert.deepEqual(f.live[0].comments, []);
  assert.deepEqual(f.speech, []);
});

test("minutes rollover preserves the project model, recent context and original task association", async (t) => {
  const f = await fixture(t);
  let now = 1000;
  const projects = new Projects(f.engine.store, () => now);
  const first = projects.accept(
    { eventId: "first", projectId: "project", text: "前提を覚えてください" },
    "fixture",
  );
  await f.input(first);
  await f.core.flush(first.meetingId);
  await f.idle();
  now += 600000;
  const next = projects.accept(
    { eventId: "next", projectId: "project", text: "続きの会話" },
    "fixture",
  );
  assert.notEqual(first.meetingId, next.meetingId);
  await f.input(next);
  await f.core.flush(next.meetingId);
  await f.idle();
  assert.equal(f.factories.length, 1);
  assert.match(f.calls.at(-1)!.observation.context!, /前提を覚えてください/);
  assert.equal(
    f.messages().find((m) => m.text === "前提を覚えてください")!.meetingId,
    first.meetingId,
  );
  f.engine.store.put("project", "other", {
    id: "other",
    name: "Other",
    remote: "",
  });
  const other = projects.accept(
    { eventId: "other", projectId: "other", text: "別の会話" },
    "fixture",
  );
  await f.input(other);
  await f.core.flush(other.meetingId);
  assert.equal(f.factories.length, 2);
  assert.doesNotMatch(
    f.calls.at(-1)!.observation.context!,
    /前提を覚えてください/,
  );
});
