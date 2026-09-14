import assert from "node:assert/strict";
import test from "node:test";
import { contextToolHandler } from "../src/execution/knowledge.js";
import { meetingModel } from "../src/agents/model-selection.js";

test("context callbacks require the active task thread and discard answers after cancellation", async () => {
  const abort = new AbortController();
  const value: any = { task: { id: "task", runId: "run" } };
  const calls: unknown[] = [];
  let complete!: (result: unknown) => void;
  const executor: any = {
    active: new Map([["run", { thread: { id: "thread" }, abort }]]),
    deletedTasks: {},
    knowledge: async (task: unknown, input: unknown) => {
      calls.push({ task, input });
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  };
  const handler = contextToolHandler(executor, value);
  const params = {
    threadId: "thread",
    tool: "meeting_context_search",
    arguments: { query: "検索" },
  };
  await assert.rejects(
    handler({ ...params, threadId: "another" }),
    /TASK_CONTEXT_UNAVAILABLE/,
  );
  await assert.rejects(
    handler({ ...params, tool: "shell" }),
    /UNKNOWN_CONTEXT_TOOL/,
  );
  await assert.rejects(
    handler({ ...params, arguments: { projectId: "foreign" } }),
    /INVALID_CONTEXT_QUERY/,
  );
  await assert.rejects(
    handler({ ...params, tool: "meeting_context_read" }),
    /SOURCE_IDS_REQUIRED/,
  );
  assert.equal(calls.length, 0);
  const pending = handler(params);
  abort.abort();
  complete({ messages: [{ text: "revoked data" }] });
  await assert.rejects(pending, /TASK_CONTEXT_UNAVAILABLE/);
});

test("meeting model selection stays in the available budget tier and adjusts effort", () => {
  const catalog = ["gpt-5.6-sol", "gpt-5.3-codex-spark", "gpt-6-astra"];
  assert.deepEqual(meetingModel("APIの引数を調べる", "research", catalog), {
    model: "gpt-5.3-codex-spark",
    reasoningEffort: "low",
  });
  assert.deepEqual(
    meetingModel("ボタンのモックを作る", "implementation", catalog),
    { model: "gpt-5.6-sol", reasoningEffort: "medium" },
  );
  assert.deepEqual(
    meetingModel("複数サービスの移行を設計する", "implementation", catalog),
    { model: "gpt-5.6-sol", reasoningEffort: "high" },
  );
  assert.equal(
    meetingModel("APIを調べる", "research", ["gpt-5.6-sol"]).model,
    "gpt-5.6-sol",
  );
  assert.throws(
    () => meetingModel("作る", "implementation", ["gpt-6-astra"]),
    /MEETING_MODEL_UNAVAILABLE/,
  );
});
