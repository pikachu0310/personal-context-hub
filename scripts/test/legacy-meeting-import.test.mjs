import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../../packages/engine/src/adapters/sqlite/store.ts";
import { importMeeting } from "../import-legacy-meeting.mjs";

test("legacy import keeps raw evidence, task identity, worktree and Codex history without replaying work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-migration-"));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  store.put("project", "project", { id: "project", name: "会議" });
  store.put("device", "device", {
    id: "device",
    name: "Client",
    revoked: false,
  });
  const binding = {
    guildId: "guild",
    voiceChannelId: "voice",
    issueForumChannelId: "text",
    projectId: "project",
    messageContentIntent: "false",
  };
  const snapshot = {
    updatedAt: "2026-09-15T00:00:00Z",
    meeting: { meetingId: "meeting", minutes: "元の議事録" },
    tasks: [
      {
        id: "old-task",
        state: "completed",
        title: "試作",
        request: "青いボタンを作る",
        runRevision: 3,
        workingDirectory: directory,
        codexThreadId: "old-codex-thread",
        threadId: "old-discord-thread",
        result: "試作を作成",
        createdAt: 1,
        sourceSequences: [2],
        sourceStatements: [
          {
            userId: "speaker",
            speakerName: "話者A",
            text: "青いボタンにしたい",
          },
        ],
      },
    ],
  };
  const record = {
    id: "raw",
    meetingId: "meeting",
    guildId: "guild",
    voiceChannelId: "voice",
    textChannelId: "text",
    sequence: 2,
    userId: "speaker",
    speakerName: "話者A",
    startedAt: 1000,
    recordedAt: 2000,
    text: "青いボタンにしたい",
  };
  const savedRuns = { runs: {}, commands: [] };
  const inputs = {
    store,
    snapshot,
    records: [record, { ...record, id: "unrelated", textChannelId: "other" }],
    savedRuns,
    projectId: "project",
    deviceId: "device",
    binding,
  };
  assert.deepEqual(importMeeting(inputs), {
    messages: 1,
    tasks: 1,
    retainedRuns: 1,
    threadBindings: 1,
  });
  const task = store.get("task", "old-task");
  assert.equal(task.state, "completed");
  assert.equal(task.revision, 3);
  assert.deepEqual(task.sourceIds, ["raw"]);
  assert.equal(store.get("message", "raw").text, record.text);
  assert.equal(store.get("message", "unrelated"), undefined);
  assert.equal(store.get("meeting", "meeting").summary, "元の議事録");
  assert.equal(savedRuns.runs[task.runId].threadId, "old-codex-thread");
  assert.equal(savedRuns.runs[task.runId].directory, directory);
  assert.equal(savedRuns.runs[task.runId].meetingToolsEnabled, false);
  savedRuns.runs[task.runId].result = "移行後の更新";
  assert.deepEqual(importMeeting(inputs), {
    messages: 0,
    tasks: 0,
    retainedRuns: 0,
    threadBindings: 0,
  });
  assert.equal(savedRuns.runs[task.runId].result, "移行後の更新");
  assert.equal(store.db.prepare("SELECT count(*) as n FROM outbox").get().n, 0);
  assert.throws(
    () =>
      importMeeting({
        ...inputs,
        snapshot: {
          ...snapshot,
          tasks: [{ ...snapshot.tasks[0], state: "running" }],
        },
      }),
    /LEGACY_TASKS_ACTIVE/,
  );
});
