import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import type {
  CoordinatorHandle,
  CoordinatorObservation,
} from "@ido/common/contracts/coordinator";
import { AppServerCodex } from "@ido/common/runtime/codex/app-server";
import {
  createCodexCoordinatorFactory,
  type CoordinatorDriver,
} from "../src/adapters/codex/coordinator.js";
import {
  coordinatorPrompt,
  parseCoordinatorResponse,
} from "../src/adapters/codex/prompt.js";

const silent = { reply: null, tasks: [], controls: [] };
const observation = (
  id = "one",
  meetingId = "meeting",
): CoordinatorObservation => ({
  meetingId,
  mode: "text-speech",
  activeTasks: [],
  context: "initial context",
  events: [
    {
      type: "message",
      id: `event-${id}`,
      source: {
        id,
        authorId: "actor",
        text: `input ${id}`,
        at: 1,
        origin: "text",
        command: "ask",
        researchAllowed: true,
        workAllowed: false,
      },
    },
  ],
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Expected provider state was not reached");
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ido-coordinator-"));
  const configurations: Record<string, any>[] = [];
  const threads: Array<any> = [];
  const calls: Array<{
    prompt: string;
    signal: AbortSignal;
    outputSchema: unknown;
  }> = [];
  const steers: string[] = [];
  let gate: ReturnType<typeof deferred> | undefined;
  let steerError = false;
  let incomplete = false;
  let preparationFailed = false;
  let closes = 0;
  const factory = createCodexCoordinatorFactory(
    { directory, codexExecutable: "fixture-codex" },
    {
      createDriver(config) {
        configurations.push(config);
        const make = (options: Record<string, unknown>, resumed?: string) => {
          let threadId = resumed;
          const thread = {
            get id() {
              return threadId;
            },
            options,
            resumed,
            disposed: false,
            active: false,
            async prepare() {
              if (preparationFailed)
                throw new Error("fixture auth unavailable");
              threadId ??= `thread-${threads.indexOf(thread) + 1}`;
            },
            async runStreamed(
              prompt: string,
              options: { signal: AbortSignal; outputSchema: unknown },
            ) {
              calls.push({ prompt, ...options });
              const hold = gate;
              return {
                events: (async function* () {
                  yield { type: "thread.started", thread_id: threadId };
                  thread.active = true;
                  yield { type: "turn.started" };
                  try {
                    await hold?.promise;
                    options.signal.throwIfAborted();
                    yield {
                      type: "item.completed",
                      item: {
                        type: "agent_message",
                        text: JSON.stringify(silent),
                      },
                    };
                    if (!incomplete) yield { type: "turn.completed" };
                  } finally {
                    thread.active = false;
                  }
                })(),
              };
            },
            async steer(prompt: string) {
              if (steerError) throw new Error("fixture timeout");
              steers.push(prompt);
              return thread.active;
            },
            async dispose() {
              thread.disposed = true;
            },
          };
          threads.push(thread);
          return thread;
        };
        return {
          startThread: (options) => make(options),
          resumeThread: (id, options) => make(options, id),
          close: async () => {
            closes++;
          },
        };
      },
    },
  );
  t.after(async () => {
    gate?.resolve();
    await factory.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    factory,
    configurations,
    threads,
    calls,
    steers,
    hold: () => (gate = deferred()),
    setSteerError: () => {
      steerError = true;
    },
    setIncomplete: (value: boolean) => {
      incomplete = value;
    },
    setPreparationFailure: (value: boolean) => {
      preparationFailed = value;
    },
    get closes() {
      return closes;
    },
  };
}

test("Engine coordinator is lazy and does not need a Client or credentials to construct", async (t) => {
  const f = await fixture(t);
  await f.factory.createCoordinator({ meetingId: "meeting" });
  assert.equal(f.configurations.length, 0);
  assert.equal(f.factory.codexHome, join(f.directory, "codex"));
  await assert.rejects(stat(f.factory.codexHome), { code: "ENOENT" });
});

test("one meeting retains its thread and checkpoints before the first model turn", async (t) => {
  const f = await fixture(t);
  const handles: CoordinatorHandle[] = [];
  const runtime = await f.factory.createCoordinator({
    meetingId: "meeting",
    onCheckpoint(handle) {
      assert.equal(f.calls.length, 0);
      handles.push(handle);
    },
  });
  assert.deepEqual(await runtime.run(observation()), silent);
  assert.deepEqual(await runtime.run(observation("two")), silent);
  assert.equal(f.configurations.length, 1);
  assert.equal(f.threads.length, 1);
  assert.deepEqual(handles, [
    { backend: "codex", meetingId: "meeting", threadId: "thread-1" },
  ]);
  assert.equal(f.configurations[0].env.CODEX_HOME, f.factory.codexHome);
  assert.equal(f.configurations[0].config.features.shell_tool, false);
  assert.equal(f.configurations[0].config.features.multi_agent, false);
  assert.equal(f.threads[0].options.sandboxMode, "read-only");
  assert.equal(f.threads[0].options.networkAccessEnabled, false);
  assert.equal(f.threads[0].options.disableShellTool, true);
  assert.equal(f.threads[0].options.model, "gpt-5.6-sol");
  assert.match(f.calls[0].prompt, /initial context/);
  assert.doesNotMatch(f.calls[1].prompt, /initial context|input one/);
});

test("resume handles remain meeting scoped and closing one coordinator does not close another", async (t) => {
  const f = await fixture(t);
  const first = await f.factory.createCoordinator({
    meetingId: "meeting",
    handle: { backend: "codex", meetingId: "meeting", threadId: "saved" },
  });
  await first.run(observation());
  const second = await f.factory.createCoordinator({ meetingId: "other" });
  await second.run(observation("other", "other"));
  assert.equal(f.threads[0].resumed, "saved");
  await assert.rejects(
    f.factory.createCoordinator({
      meetingId: "wrong",
      handle: { backend: "codex", meetingId: "meeting", threadId: "saved" },
    }),
    { code: "COORDINATOR_HANDLE_MISMATCH" },
  );
  await assert.rejects(f.factory.createCoordinator({ meetingId: "meeting" }), {
    code: "COORDINATOR_ALREADY_OPEN",
  });
  assert.throws(() => first.run(observation("bad", "other")), {
    code: "COORDINATOR_MEETING_MISMATCH",
  });
  await first.close();
  assert.equal(f.threads[0].disposed, true);
  assert.equal(f.threads[1].disposed, false);
  assert.deepEqual(
    await second.run(observation("still-running", "other")),
    silent,
  );
});

test("active steering preserves message IDs and unknown delivery remains an explicit error", async (t) => {
  const f = await fixture(t);
  const hold = f.hold();
  const runtime = await f.factory.createCoordinator({ meetingId: "meeting" });
  assert.equal(await runtime.steer(observation("early")), false);
  const running = runtime.run(observation());
  await until(() => f.threads[0]?.active);
  await assert.rejects(runtime.run(observation("busy")), {
    code: "COORDINATOR_BUSY",
    delivery: "rejected",
  });
  assert.equal(await runtime.steer(observation("correction")), true);
  assert.match(f.steers[0], /"id":"correction"/);
  f.setSteerError();
  await assert.rejects(runtime.steer(observation("unknown")), {
    code: "COORDINATOR_STEER_UNCERTAIN",
    delivery: "unknown",
  });
  hold.resolve();
  await running;
});

test("closing an active coordinator waits for actual provider settlement", async (t) => {
  const f = await fixture(t);
  const hold = f.hold();
  const runtime = await f.factory.createCoordinator({ meetingId: "meeting" });
  const running = runtime.run(observation()).catch((error) => error);
  await until(() => f.threads[0]?.active);
  let settled = false;
  const closing = runtime.close().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.threads[0].disposed, false);
  assert.equal(settled, false);
  hold.resolve();
  assert.equal((await running).delivery, "unknown");
  await closing;
  assert.equal(f.threads[0].disposed, true);
});

test("preparation and checkpoint failures never start a model turn and can be retried deliberately", async (t) => {
  const f = await fixture(t);
  let writable = false;
  const runtime = await f.factory.createCoordinator({
    meetingId: "meeting",
    onCheckpoint() {
      if (!writable) throw new Error("disk unavailable");
    },
  });
  f.setPreparationFailure(true);
  await assert.rejects(runtime.run(observation()), {
    code: "COORDINATOR_UNAVAILABLE_CHECK_ENGINE_CODEX_LOGIN",
    delivery: "rejected",
  });
  f.setPreparationFailure(false);
  await assert.rejects(runtime.run(observation()), { delivery: "rejected" });
  assert.equal(f.calls.length, 0);
  writable = true;
  assert.deepEqual(await runtime.run(observation()), silent);
});

test("incomplete model runs cannot become successful responses", async (t) => {
  const f = await fixture(t);
  const runtime = await f.factory.createCoordinator({ meetingId: "meeting" });
  f.setIncomplete(true);
  await assert.rejects(runtime.run(observation()), {
    code: "COORDINATOR_RESPONSE_UNCERTAIN",
    delivery: "unknown",
  });
  f.setIncomplete(false);
  assert.deepEqual(await runtime.run(observation("next")), silent);
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

test("Engine coordinator uses the shared App Server protocol with read-only settings and active-turn steer", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-coordinator-rpc-"));
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");
  };
  const messages: any[] = [];
  const emit = (value: unknown) =>
    child.stdout.write(JSON.stringify(value) + "\n");
  let buffer = "";
  child.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"),
        message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      messages.push(message);
      if (message.id === undefined) continue;
      emit({
        id: message.id,
        result:
          message.method === "thread/resume"
            ? { thread: { id: "saved" } }
            : message.method === "turn/start"
              ? { turn: { id: "active" } }
              : message.method === "turn/steer"
                ? { turnId: "active" }
                : {},
      });
    }
  });
  const factory = createCodexCoordinatorFactory(
    { directory, codexExecutable: "fixture" },
    {
      createDriver: (options) =>
        new AppServerCodex(options, {
          spawnProcess: () => child,
          requestTimeoutMs: 1000,
        }) as unknown as CoordinatorDriver,
    },
  );
  t.after(async () => {
    await factory.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const runtime = await factory.createCoordinator({
    meetingId: "meeting",
    handle: { backend: "codex", meetingId: "meeting", threadId: "saved" },
  });
  const pending = runtime.run(observation());
  await until(() =>
    messages.some((message) => message.method === "turn/start"),
  );
  const params = messages.find(
    (message) => message.method === "thread/resume",
  ).params;
  assert.equal(params.sandbox, "read-only");
  assert.equal(params.config["features.shell_tool"], false);
  assert.equal(params.config["features.unified_exec"], false);
  assert.equal(await runtime.steer(observation("new")), true);
  assert.equal(
    messages.find((message) => message.method === "turn/steer").params
      .expectedTurnId,
    "active",
  );
  emit({
    method: "item/completed",
    params: {
      threadId: "saved",
      turnId: "active",
      item: { type: "agentMessage", text: JSON.stringify(silent) },
    },
  });
  emit({
    method: "turn/completed",
    params: { threadId: "saved", turn: { id: "active", status: "completed" } },
  });
  assert.deepEqual(await pending, silent);
  await runtime.close();
  assert.ok(
    messages.some((message) => message.method === "thread/unsubscribe"),
  );
});
