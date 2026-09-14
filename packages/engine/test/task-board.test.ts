import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/adapters/sqlite/store.js";
import { TaskBoard, type BoardThread } from "../src/processing/tasks/board.js";
import { Tasks } from "../src/processing/tasks/service.js";
import { WorkspaceLifecycle } from "../src/processing/projects/lifecycle.js";
import type { Task } from "@ido/common/contracts/protocol";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ido-board-"));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const user = store.createUser("operator", "fixture-password-long", "admin");
  store.put("project", "project", {
    id: "project",
    name: "Example",
    remote: "",
  });
  const tasks = new Tasks(store),
    board = new TaskBoard(store);
  const create = (requestId: string) =>
    tasks.createTask({
      projectId: "project",
      meetingId: "meeting",
      authorId: user.id,
      requestId,
      text: requestId,
      network: false,
    });
  const a = create("API"),
    b = create("UI");
  return { directory, store, board, a, b, create, user };
}

test("free discussions use task threads, preserve authors and do not change task state", async (t) => {
  const { board, store, a, b } = await fixture(t);
  const before = store.get("task", a.id);
  const first = board.post(
    a,
    { body: "APIを相談したい。分類は自由です。" },
    "one",
  );
  board.post(
    b,
    {
      taskId: a.id,
      body: "UI側からはこの形が便利です。",
      replyTo: first.id,
      authorTaskId: a.id,
    },
    "two",
  );
  const discussion = board.read(b, { taskId: a.id }) as any;
  assert.deepEqual(
    discussion.posts.map((post: any) => post.authorTaskId),
    [a.id, b.id],
  );
  assert.equal(discussion.posts[1].replyTo, first.id);
  assert.deepEqual(store.get("task", a.id), before);
  assert.throws(
    () => board.post(b, { body: "different thread", replyTo: first.id }, "bad"),
    /REPLY_NOT_FOUND/,
  );
  store.put("task", "foreign", { ...a, id: "foreign", projectId: "other" });
  assert.throws(() => board.read(a, { taskId: "foreign" }), /THREAD_NOT_FOUND/);
  assert.throws(
    () => board.post(a, { taskId: "foreign", body: "no" }, "foreign"),
    /THREAD_NOT_FOUND/,
  );
});

test("default listing and search exclude finished tasks while explicit reads and resumption retain history", async (t) => {
  const { board, store, a, b } = await fixture(t);
  board.post(a, { body: "共有仕様の古い議論" }, "a");
  board.post(b, { body: "共有仕様の現在の議論" }, "b");
  for (const state of ["completed", "failed", "cancelled"] as Task["state"][]) {
    store.put("task", a.id, { ...a, state });
    assert.deepEqual(
      (board.read(b) as any).threads.map((thread: any) => thread.id),
      [b.id],
    );
    assert.equal(
      (board.read(b, { query: "共有仕様" }) as any).threads.length,
      1,
    );
    assert.equal(
      (board.read(b, { query: "共有仕様", includeFinished: true }) as any)
        .threads.length,
      2,
    );
    assert.equal(
      (board.read(b, { taskId: a.id }) as any).thread.finished,
      true,
    );
  }
  store.put("task", a.id, { ...a, state: "queued" });
  assert.equal((board.read(b) as any).threads.length, 2);
  assert.equal(
    (board.read(b, { taskId: a.id, id: 1 }) as any).body,
    "共有仕様の古い議論",
  );
});

test("bounded thread and post reads retain full Unicode text and incremental history", async (t) => {
  const { board, a, create } = await fixture(t);
  const body = "x".repeat(3999) + "🐥" + "続き".repeat(3000);
  for (let n = 0; n < 24; n++) board.post(a, { body }, String(n));
  const recent = board.read(a, { taskId: a.id }) as any;
  assert.equal(recent.posts.length, 10);
  assert.equal(recent.omitted, 14);
  assert.ok(
    recent.posts.every(
      (post: any) => post.body.length <= 600 && post.truncated,
    ),
  );
  let after = 0;
  const ids = [];
  for (;;) {
    const page = board.read(a, { taskId: a.id, after }) as any;
    if (!page.posts.length) break;
    ids.push(...page.posts.map((post: any) => post.id));
    after = page.nextAfter;
  }
  assert.equal(new Set(ids).size, 24);
  let offset: number | null = 0,
    content = "";
  do {
    const page = board.read(a, { id: 1, offset }) as any;
    content += page.body;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(content, body);
  assert.equal((board.read(a, { id: 1 }) as any).nextOffset, 3999);
  for (let n = 0; n < 20; n++) create(`more-${n}`);
  const page = board.read(a) as any;
  assert.equal(page.threads.length, 10);
  assert.equal(
    (board.read(a, { offset: page.nextOffset }) as any).threads.length,
    10,
  );
  assert.throws(() => board.read(a, { limit: 10000 }));
  assert.throws(() => board.post(a, { body: "x".repeat(16001) }, "long"));
});

test("SQLite persists discussions, rejects changed retries and rolls back failed writes", async (t) => {
  const { board, store, directory, a } = await fixture(t);
  const first = board.post(a, { body: "原文" }, "retry");
  const otherConnection = new Store(directory);
  try {
    const restored = new TaskBoard(otherConnection);
    assert.equal((restored.read(a, { id: first.id }) as any).body, "原文");
    assert.deepEqual(restored.post(a, { body: "原文" }, "retry"), {
      ...first,
      created: false,
    });
    assert.throws(
      () => restored.post(a, { body: "改変" }, "retry"),
      /RETRY_CHANGED/,
    );
  } finally {
    otherConnection.close();
  }
  const put = t.mock.method(store, "put", () => {
    throw new Error("disk full");
  });
  assert.throws(() => board.post(a, { body: "未保存" }, "failed"), /disk full/);
  put.mock.restore();
  assert.equal((board.read(a, { taskId: a.id }) as any).posts.length, 1);
  assert.equal(board.post(a, { body: "回復" }, "recovered").id, 2);
});

test("explicit task deletion purges its discussion and its posts elsewhere without reusing IDs", async (t) => {
  const { board, store, a, b, user } = await fixture(t);
  board.post(a, { body: "削除するタスクの議論" }, "own");
  board.post(b, { body: "残す投稿" }, "other");
  board.post(a, { taskId: b.id, body: "他スレッドへの発言" }, "cross");
  await new WorkspaceLifecycle(store).deleteTask(
    { user, valid: () => true },
    a.id,
    {
      confirm: true,
      revision: a.revision,
      controlVersion: 0,
      membershipVersion: a.membershipVersion ?? 0,
    },
  );
  assert.equal(store.get("task-board", a.id), undefined);
  assert.equal(store.get<BoardThread>("task-board", b.id)?.posts.length, 1);
  assert.equal(board.post(b, { body: "新しい投稿" }, "new").id, 3);
  assert.throws(() => board.read(b, { taskId: a.id }), /THREAD_NOT_FOUND/);
});
