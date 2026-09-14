import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, type Client } from "discord.js";
import type { Task } from "@ido/common/contracts/protocol";
import {
  ForumSync,
  ForumCreateRejected,
  forumCommand,
  forumKey,
  type ForumRecord,
} from "../src/forum/sync.js";
import { normalizeInput } from "../src/input/normalize.js";
import { forumTransport } from "../src/forum/transport.js";
import { connectionPage, validateDownloads } from "../src/onboarding/guide.js";
const binding = {
  guildId: "1",
  issueForumChannelId: "123456789012345678",
  meetingId: "meeting",
  projectId: "project",
};
test("forum transport fences mutations when configuration changes during channel lookup", async () => {
  let valid = true;
  let writes = 0;
  const client = {
    channels: {
      fetch: async () => {
        valid = false;
        return {
          type: ChannelType.GuildForum,
          guildId: binding.guildId,
          threads: {
            create: async () => {
              writes++;
              return { id: "thread" };
            },
          },
        };
      },
    },
  } as unknown as Client;
  await assert.rejects(
    forumTransport(client, binding, () => valid).create("title", "content"),
    /FORUM_CONFIG_CHANGED/,
  );
  assert.equal(writes, 0);
});
test("definitive Discord rejection can retry after permissions are repaired", async () => {
  let saved: ForumRecord[] | undefined;
  let rejected = true;
  let attempts = 0;
  const sync = new ForumSync(
    binding,
    {
      find: async () => undefined,
      create: async () => {
        attempts++;
        if (rejected) throw new ForumCreateRejected("FORBIDDEN");
        return "thread";
      },
      update: async () => {},
    },
    async () => saved,
    async (records) => {
      saved = structuredClone(records);
    },
  );
  await assert.rejects(sync.sync([task()]));
  rejected = false;
  await sync.sync([task()]);
  assert.equal(attempts, 2);
  assert.equal(sync.taskForThread("thread"), "task");
});
const task = (state: Task["state"] = "queued"): Task => ({
  id: "task",
  requestId: "request",
  projectId: "project",
  meetingId: "meeting",
  authorId: "owner",
  text: "Implement @everyone page",
  state,
  runId: "run",
  revision: 1,
  network: false,
  createdAt: 1,
  updatedAt: 2,
  history: [],
  progress: "private log",
  result: "private patch",
});
function fixture() {
  let saved: ForumRecord[] | undefined;
  let creates = 0,
    edits = 0;
  let visible: string | undefined;
  let ambiguous = false;
  const messages: string[] = [];
  const make = (valid?: () => boolean) =>
    new ForumSync(
      binding,
      {
        find: async () => visible,
        create: async (_name, content) => {
          assert.ok(saved?.some((r) => r.taskId === "task"));
          creates++;
          visible = "thread";
          messages.push(content);
          if (ambiguous) throw new Error("TIMEOUT");
          return visible;
        },
        update: async (_id, content) => {
          edits++;
          messages.push(content);
        },
      },
      async () => structuredClone(saved),
      async (records) => {
        saved = structuredClone(records);
      },
      valid,
    );
  return {
    make,
    messages,
    counts: () => ({ creates, edits }),
    ambiguous: () => {
      ambiguous = true;
    },
    hide: () => {
      visible = undefined;
    },
  };
}

test("canonical conversation delivery resumes partial posts without duplicates and recovery verifies ownership", async () => {
  let saved: ForumRecord[] | undefined;
  const sent = new Set<string>();
  let fail = true,
    updates = 0;
  const sync = new ForumSync(
    binding,
    {
      create: async () => "thread",
      find: async () => "thread",
      update: async () => {
        updates++;
      },
      verify: async (threadId) => threadId === "thread",
      findPost: async (_threadId, marker) => sent.has(marker),
      post: async (_threadId, marker) => {
        assert.ok(saved?.some((record) => record.pendingPost === marker));
        assert.equal(sent.has(marker), false);
        sent.add(marker);
        if (fail) {
          fail = false;
          throw new Error("TIMEOUT_AFTER_SEND");
        }
      },
    },
    async () => saved,
    async (records) => {
      saved = structuredClone(records);
    },
  );
  const item = {
    ...task(),
    boardPosts: [
      { id: 1, body: "x".repeat(4000), author: "Member" },
      {
        id: 2,
        body: "Native Discord message",
        author: "Discord Member",
        external: true,
      },
    ],
  };
  await assert.rejects(sync.sync([item]));
  assert.equal(sync.status().length, 1);
  await sync.sync([item]);
  await sync.sync([item]);
  assert.equal(sent.size, 3);
  assert.equal(sync.postCursors().task, 2);
  assert.equal(saved?.[0].error, undefined);
  await assert.rejects(
    sync.recover("task", "unrelated-thread"),
    /STARTER_MISMATCH/,
  );
  assert.equal(updates, 0);
  await sync.recover("task", "thread");
  assert.equal(updates, 1);
});
test("inspection detects deleted unchanged threads and explicit recreation restores them", async () => {
  let saved: ForumRecord[] | undefined,
    exists = true,
    creates = 0;
  const sync = new ForumSync(
    binding,
    {
      find: async () => undefined,
      create: async () => {
        exists = true;
        return `thread-${++creates}`;
      },
      update: async () => {},
      verify: async () => exists,
    },
    async () => saved,
    async (records) => {
      saved = structuredClone(records);
    },
  );
  await sync.sync([task("completed")]);
  exists = false;
  assert.equal((await sync.inspect())[0].error, "FORUM_THREAD_NOT_AVAILABLE");
  assert.equal(creates, 1);
  await sync.recover("task", undefined, true);
  await sync.sync([task("completed")]);
  assert.equal(creates, 2);
  assert.deepEqual(await sync.inspect(), []);
});

test("forum serializes concurrent events, restores mapping and edits one starter", async () => {
  const f = fixture(),
    sync = f.make();
  await Promise.all([sync.sync([task()]), sync.sync([task()])]);
  assert.deepEqual(f.counts(), { creates: 1, edits: 0 });
  const restarted = f.make();
  await restarted.sync([task("running")]);
  assert.equal(restarted.taskForThread("thread"), "task");
  assert.deepEqual(f.counts(), { creates: 1, edits: 1 });
  await restarted.sync([task("completed")]);
  assert.match(f.messages.at(-1)!, /completed/);
  assert.ok(
    f.messages.every((m) => !m.includes("@everyone") && !m.includes("private")),
  );
});
test("uncertain thread creation reconciles without duplicate; bounded miss never recreates", async () => {
  const f = fixture();
  f.ambiguous();
  await assert.rejects(f.make().sync([task()]), /FORUM_SYNC_INCOMPLETE/);
  const sync = f.make();
  f.hide();
  await assert.rejects(sync.sync([task()]), /FORUM_SYNC_INCOMPLETE/);
  assert.equal(f.counts().creates, 1);
  const g = fixture();
  g.ambiguous();
  await assert.rejects(g.make().sync([task()]));
  const restored = g.make();
  await restored.sync([task("running")]);
  assert.equal(restored.taskForThread("thread"), "task");
  assert.equal(g.counts().creates, 1);
});
test("forum binding fences switched configuration and unrelated tasks", async () => {
  const f = fixture();
  let valid = true;
  const sync = f.make(() => valid);
  await sync.sync([{ ...task(), projectId: "other" }]);
  assert.equal(f.counts().creates, 0);
  await sync.sync([task()]);
  valid = false;
  await sync.sync([task("running")]);
  assert.equal(sync.taskForThread("thread"), undefined);
  assert.equal(f.counts().edits, 0);
  assert.equal(forumKey(binding), forumKey({ ...binding, meetingId: "other" }));
});
test("forum input requires mapped task, current guild, participant policy and explicit controls", () => {
  const config = { ...binding, textChannelId: "text", userPolicy: "all" };
  const event = {
    guildId: "1",
    channelId: "thread",
    userId: "100",
    eventId: "event",
    text: "stop",
    command: forumCommand(" stop "),
    taskId: "task",
  };
  assert.equal(normalizeInput(event, config), undefined);
  const normalized = normalizeInput(
    event,
    config,
    undefined,
    undefined,
    "task",
  )!;
  assert.equal(normalized.command, "stop");
  assert.equal(normalized.replyTo?.channelId, "thread");
  assert.equal(
    normalizeInput(
      { ...event, command: "task" },
      config,
      undefined,
      undefined,
      "task",
    ),
    undefined,
  );
  assert.equal(
    normalizeInput(
      { ...event, guildId: "other" },
      config,
      undefined,
      undefined,
      "task",
    ),
    undefined,
  );
  assert.equal(
    normalizeInput(
      { ...event, taskId: "other" },
      config,
      undefined,
      undefined,
      "task",
    ),
    undefined,
  );
  assert.equal(
    normalizeInput(
      event,
      { ...config, userPolicy: "allowlist", allowedUserIds: "200" },
      undefined,
      undefined,
      "task",
    ),
    undefined,
  );
  assert.equal(forumCommand("stopボタンを追加して"), "context");
  assert.equal(forumCommand("指示: stopボタンを追加して"), "steer");
  assert.equal(forumCommand("再開: 続けて"), "steer");
});
test("onboarding uses explicit download URLs, escaped HTML and prefill-only deep link", () => {
  const html = connectionPage("https://engine.example.com", {
    windowsDownloadUrl: 'https://example.com/app.exe?label="<script>',
    botToken: "private-bot-token",
  });
  assert.match(
    html,
    /ido-agent:\/\/connect\?engine=https%3A%2F%2Fengine.example.com/,
  );
  assert.match(html, /Windows版をダウンロード/);
  assert.match(html, /配布準備中/);
  assert.ok(!html.includes("private-bot-token") && !html.includes("<script>"));
  for (const url of [
    "javascript:alert(1)",
    "file:///tmp/app",
    "https://user:pass@example.com/app",
    "http://example.com/app",
  ])
    assert.throws(() => validateDownloads({ windowsDownloadUrl: url }));
});
