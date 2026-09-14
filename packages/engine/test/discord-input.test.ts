import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Meeting } from "../src/store.js";
import { Conversation } from "../src/ai.js";
import { DiscordInput, taskControl } from "../src/discord-input.js";
import { Credentials } from "../../common/src/credentials.js";
import { normalizeDiscordPolicy } from "../../common/src/discord-policy.js";
import type { Task } from "../../common/src/protocol.js";

async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "ido-discord-input-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const config = {
    guildId: "1",
    textChannelId: "2",
    projectId: "project",
    meetingId: "meeting",
  };
  store.put("config", "discord", config);
  store.put("project", "project", { id: "project", name: "Test" });
  store.put("meeting", "meeting", {
    id: "meeting",
    name: "Test",
    summary: "",
    messages: [],
  });
  const ai = new Conversation(store, new Credentials(dir, "test", "file"));
  let transcriptions = 0,
    answers = 0,
    speech = 0;
  ai.transcribe = async () => {
    transcriptions++;
    return "通常の会話です";
  };
  ai.answer = async () => {
    answers++;
    return "質問の回答です。";
  };
  ai.speak = async () => {
    speech++;
    return "synthetic-audio";
  };
  ai.api = async () =>
    ({
      responses: {
        create: async () => ({
          output_text: JSON.stringify({ minutes: "議事録", task: null }),
        }),
      },
    }) as any;
  const output: any[] = [];
  const plugin = {
    voiceChannelId: "3",
    voiceGeneration: 1,
    publish: (...args: any[]) => output.push(["publish", ...args]),
    deliver: (...args: any[]) => output.push(["deliver", ...args]),
    commandResult: (...args: any[]) => output.push(["command", ...args]),
  };
  const input = new DiscordInput(store, ai, plugin as any, () => {});
  const event = {
    guildId: "1",
    channelId: "3",
    userId: "100",
    eventId: "voice-one",
    audio: "dGVzdA==",
    speechEpoch: 1,
  };
  const task = (name = "Implement feature") =>
    store.createTask({
      projectId: "project",
      meetingId: "meeting",
      authorId: "discord-100",
      text: name,
      requestId: name,
      network: false,
    });
  return {
    store,
    ai,
    plugin,
    input,
    output,
    config,
    event,
    task,
    counts: () => ({ transcriptions, answers, speech }),
  };
}

test("joined channel accepts unlinked speakers by default without creating dashboard accounts", async (t) => {
  const f = await fixture(t);
  await f.input.handle(f.event);
  assert.equal(f.counts().transcriptions, 1);
  assert.equal(f.store.users().length, 0);
  assert.equal(f.store.list("discord-user").length, 0);
  assert.equal(f.store.conversationAuthor("discord-100")?.role, "member");
  assert.equal(f.store.get<Meeting>("meeting", "meeting")!.messages.length, 1);
  assert.deepEqual(
    f.output.map((v) => v.slice(0, 2)),
    [
      ["publish", "transcript"],
      ["publish", "minutes"],
    ],
  );
  assert.equal(
    f.counts().speech,
    0,
    "unaddressed conversation is not read aloud",
  );
  await f.input.handle(f.event);
  assert.equal(f.counts().transcriptions, 1, "duplicate delivery is ignored");
});

test("policy and channel boundaries reject before STT, including empty allowlist and malformed IDs", async (t) => {
  const f = await fixture(t);
  for (const event of [
    { ...f.event, guildId: "other" },
    { ...f.event, channelId: "old" },
    { ...f.event, userId: "not-an-id" },
  ])
    await f.input.handle(event);
  f.store.put("config", "discord", {
    ...f.config,
    userPolicy: "allowlist",
    allowedUserIds: "",
  });
  await f.input.handle(f.event);
  assert.equal(f.counts().transcriptions, 0);
  f.store.put("config", "discord", {
    ...f.config,
    userPolicy: "allowlist",
    allowedUserIds: "100\n200",
  });
  await f.input.handle(f.event);
  assert.equal(f.counts().transcriptions, 1);
  f.plugin.voiceChannelId = "";
  await f.input.handle({ ...f.event, eventId: "after-leave" });
  assert.equal(f.counts().transcriptions, 1);
  assert.deepEqual(normalizeDiscordPolicy({ allowedUserIds: "100,200\n100" }), {
    userPolicy: "all",
    allowedUserIds: "100\n200",
  });
  assert.throws(() => normalizeDiscordPolicy({ allowedUserIds: "<@100>" }));
});

test("permission changes while STT is running discard the transcript before analysis", async (t) => {
  const f = await fixture(t);
  let resolve!: (s: string) => void;
  f.ai.transcribe = () =>
    new Promise((r) => {
      resolve = r;
    });
  const running = f.input.handle(f.event);
  f.store.put("config", "discord", {
    ...f.config,
    userPolicy: "allowlist",
    allowedUserIds: "",
  });
  resolve("ignored");
  await running;
  assert.equal(f.store.get<Meeting>("meeting", "meeting")!.messages.length, 0);
  assert.equal(f.output.length, 0);
});

test("simple invocation acknowledges without answer API; questions answer independently of minutes", async (t) => {
  const f = await fixture(t);
  f.ai.transcribe = async () => "井戸Bot、聞こえていますか？";
  await f.input.handle(f.event);
  assert.equal(f.counts().answers, 0);
  assert.ok(f.output.some((o) => o[2] === "はい、聞こえています。"));
  assert.ok(f.output.some((o) => o[3] === "synthetic-audio" && o[4] === 1));
  let complete!: () => void;
  f.ai.api = async () =>
    ({
      responses: {
        create: () =>
          new Promise((resolve) => {
            complete = () =>
              resolve({
                output_text: JSON.stringify({ minutes: "updated", task: null }),
              });
          }),
      },
    }) as any;
  const running = f.input.handle({
    ...f.event,
    audio: undefined,
    channelId: "2",
    eventId: "question",
    text: "井戸Bot、この会議の目的は？",
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.counts().answers, 1);
  assert.ok(f.output.some((o) => o[2] === "質問の回答です。"));
  complete();
  await running;
});

test("live transcription updates before slow minutes and preserves simultaneous speakers", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let calls = 0;
  f.ai.api = async () =>
    ({
      responses: {
        create: async () => {
          if (!calls++)
            await new Promise<void>((r) => {
              release = r;
            });
          return {
            output_text: JSON.stringify({ minutes: "updated", task: null }),
          };
        },
      },
    }) as any;
  const first = f.input.handle({
    ...f.event,
    audio: undefined,
    channelId: "2",
    text: "first",
  });
  await new Promise((r) => setImmediate(r));
  const second = f.input.handle({
    ...f.event,
    audio: undefined,
    channelId: "2",
    text: "second",
    userId: "200",
    eventId: "second",
  });
  assert.equal(f.output.filter((o) => o[1] === "transcript").length, 2);
  assert.equal(f.output.filter((o) => o[1] === "minutes").length, 0);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(
    f.store.get<Meeting>("meeting", "meeting")!.messages.map((m) => m.text),
    ["first", "second"],
  );
});

test("explicit task and natural controls use the same execution, never create a second task", async (t) => {
  const f = await fixture(t);
  await f.input.handle({
    ...f.event,
    audio: undefined,
    channelId: "2",
    command: "task",
    text: "Implement page",
  });
  assert.equal(f.store.list<Task>("task").length, 1);
  await f.input.handle({
    ...f.event,
    audio: undefined,
    channelId: "2",
    eventId: "steer",
    text: "井戸Bot、今のタスクに追加で、テストも実行して",
  });
  const task = f.store.list<Task>("task")[0];
  assert.match(task.text, /テストも実行して/);
  task.clientId = "device";
  task.state = "running";
  f.store.put("task", task.id, task);
  await f.input.handle({
    ...f.event,
    audio: undefined,
    channelId: "2",
    eventId: "steer2",
    command: "steer",
    text: "More tests",
    taskId: task.id,
  });
  assert.equal(f.store.pending("device")[0].type, "steer");
  assert.equal(f.store.pending("device")[0].runId, task.runId);
  await f.input.handle({
    ...f.event,
    audio: undefined,
    channelId: "2",
    eventId: "stop",
    text: "井戸Bot、今のタスクを止めて",
  });
  assert.equal(f.store.pending("device")[1].type, "stop");
  assert.equal(f.store.list<Task>("task").length, 1);
});

test("ambiguous tasks require an ID; viewer cannot control; controls cannot cross meetings", async (t) => {
  const f = await fixture(t);
  const first = f.task("first");
  const second = f.task("second");
  const stop = {
    ...f.event,
    audio: undefined,
    channelId: "2",
    eventId: "stop",
    command: "stop",
    interaction: true,
  };
  await f.input.handle(stop);
  assert.ok(f.output.some((o) => String(o[2]).includes("対象を特定")));
  assert.equal(f.store.get<Task>("task", first.id)!.state, "queued");
  await f.input.handle({ ...stop, eventId: "stop-id", taskId: first.id });
  assert.equal(f.store.get<Task>("task", first.id)!.state, "cancelled");
  const viewer = f.store.createUser("viewer", "test-password-long", "viewer");
  f.store.put("discord-user", "100", { userId: viewer.id });
  await f.input.handle({ ...stop, eventId: "denied", taskId: second.id });
  assert.equal(f.store.get<Task>("task", second.id)!.state, "queued");
  f.store.remove("discord-user", "100");
  second.meetingId = "other";
  f.store.put("task", second.id, second);
  await f.input.handle({
    ...stop,
    eventId: "wrong-meeting",
    taskId: second.id,
  });
  assert.equal(f.store.get<Task>("task", second.id)!.state, "queued");
  assert.equal(taskControl("「井戸Bot、止めて」と言った"), undefined);
  assert.equal(taskControl("タスクを停止するか相談しよう"), undefined);
});

test("context returns the complete minutes attachment, not a truncated excerpt", async (t) => {
  const f = await fixture(t);
  const meeting = f.store.get<Meeting>("meeting", "meeting")!;
  meeting.summary = "議事録".repeat(2000);
  f.store.put("meeting", meeting.id, meeting);
  await f.input.handle({
    ...f.event,
    audio: undefined,
    source: "voice-command",
    eventId: "context",
    command: "context",
    interaction: true,
  });
  assert.equal(f.output[0][3], meeting.summary);
  assert.equal(f.counts().transcriptions, 0);
});

test("leave and rejoin of the same channel invalidates an in-flight transcription", async (t) => {
  const f = await fixture(t);
  let resolve!: (s: string) => void;
  f.ai.transcribe = () =>
    new Promise((r) => {
      resolve = r;
    });
  const running = f.input.handle(f.event);
  f.plugin.voiceGeneration++;
  resolve("井戸Bot、古い質問");
  await running;
  assert.equal(f.output.length, 0);
  assert.equal(f.store.get<Meeting>("meeting", "meeting")!.messages.length, 0);
});

test("unlinked speakers can create extracted tasks, but revocation during analysis prevents execution", async (t) => {
  const f = await fixture(t);
  f.ai.api = async () =>
    ({
      responses: {
        create: async () => ({
          output_text: JSON.stringify({
            minutes: "Summary",
            task: "Implement requested page",
          }),
        }),
      },
    }) as any;
  await f.input.handle({
    ...f.event,
    audio: undefined,
    channelId: "2",
    text: "画面を実装して",
  });
  assert.equal(f.store.list<Task>("task").length, 1);
  assert.equal(f.store.list<Task>("task")[0].authorId, "discord-100");
  let resolve!: (v: any) => void;
  f.ai.api = async () =>
    ({
      responses: {
        create: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
    }) as any;
  const running = f.input.handle({
    ...f.event,
    eventId: "revoked-later",
    audio: undefined,
    channelId: "2",
    text: "追加の画面を実装して",
  });
  await new Promise((r) => setImmediate(r));
  f.store.put("config", "discord", {
    ...f.config,
    userPolicy: "allowlist",
    allowedUserIds: "",
  });
  resolve({
    output_text: JSON.stringify({
      minutes: "Updated",
      task: "Must not execute",
    }),
  });
  await running;
  assert.equal(f.store.list<Task>("task").length, 1);
});

test("ask stays read-only even when its question contains a control phrase", async (t) => {
  const f = await fixture(t),
    task = f.task();
  await f.input.handle({
    ...f.event,
    eventId: "ask-control",
    audio: undefined,
    channelId: "2",
    command: "ask",
    interaction: true,
    text: "今のタスクを止めて",
  });
  assert.equal(f.store.get<Task>("task", task.id)!.state, "queued");
  assert.equal(f.counts().answers, 1);
});
