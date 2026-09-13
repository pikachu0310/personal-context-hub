import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  CodexAgentTeam,
  parseCodexAgents,
} from "../src/discord-agent-team.mjs";
import { DiscordVoiceTaskQueue } from "../src/discord-voice-session.mjs";
import { CodexVoiceRunner } from "../src/discord-voice-openai.mjs";

async function eventually(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.fail("condition was not met before timeout");
}

test("a peer agent review is posted and answered by the assigned agent thread", async () => {
  const workingDirectory = resolve("agent-review-workspace");
  const team = new CodexAgentTeam(
    parseCodexAgents(
      JSON.stringify([
        {
          id: "frontend",
          name: "Frontend Codex",
          capabilities: ["ui"],
          workingDirectory,
        },
        {
          id: "reviewer",
          name: "Review Codex",
          capabilities: ["review"],
          workingDirectory,
        },
      ]),
      { workingDirectory },
    ),
  );
  const runs = [];
  const posts = [];
  let reviewCalls = 0;
  const queue = new DiscordVoiceTaskQueue({
    agentTeam: team,
    runTask: async (task) => {
      runs.push({
        assignedAgentId: task.assignedAgentId,
        instruction: task.additionalInstruction,
        source: structuredClone(task.additionalInstructionSource),
      });
      task.runRevision = (task.runRevision ?? 0) + 1;
      return runs.length === 1 ? "初回実装" : "指摘へ回答して修正済み";
    },
    reviewTask: async (task) => {
      reviewCalls += 1;
      assert.equal(task.assignedAgentId, "frontend");
      return {
        agentId: "reviewer",
        agentName: "Review Codex",
        feedback: "境界値のテストはありますか？",
        actionable: true,
      };
    },
    postText: async () => undefined,
    createTaskThread: async (task) => ({
      threadId: task.id,
      post: async (content) => posts.push(content),
      update: async () => undefined,
    }),
    checkpoint: async () => undefined,
    progressIntervalMs: 0,
  });

  assert.equal(
    await queue.enqueueDurable({
      id: "issue-ui",
      title: "UIを修正",
      request: "uiの境界値を直す",
      kind: "implementation",
    }),
    true,
  );
  await eventually(
    () => runs.length === 2 && queue.list()[0].state === "completed",
  );
  assert.equal(reviewCalls, 1);
  assert.equal(runs[0].assignedAgentId, "frontend");
  assert.equal(runs[1].instruction, "境界値のテストはありますか？");
  assert.deepEqual(runs[1].source, {
    type: "agent_review",
    agentId: "reviewer",
    agentName: "Review Codex",
  });
  assert.ok(posts.some((content) => content.includes("質問・指摘")));
  const [saved] = queue.snapshot();
  assert.equal(saved.issueId, "issue-ui");
  assert.equal(saved.assignedAgentId, "frontend");
  assert.equal(saved.peerReviews.length, 1);
  assert.deepEqual(
    await queue.handleAgentMessageDurable({
      taskId: "issue-ui",
      agentId: "reviewer",
      content: "エラー時の表示も確認してください。",
      requestKey: "reviewer-message-1",
    }),
    { type: "instruction", disposition: "resumed", pendingInstructions: 1 },
  );
  await eventually(
    () => runs.length === 3 && queue.list()[0].state === "completed",
  );
  assert.equal(runs[2].instruction, "エラー時の表示も確認してください。");
  assert.equal(runs[2].source.agentId, "reviewer");
  await queue.stop();
});

test("the runner uses the assigned agent profile and a different read-only reviewer", async () => {
  const workingDirectory = resolve("agent-runner-workspace");
  const agents = parseCodexAgents(
    JSON.stringify([
      {
        id: "builder",
        name: "Builder",
        capabilities: ["implementation"],
        workingDirectory,
        model: "builder-model",
        reasoningEffort: "high",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        capabilities: ["review"],
        workingDirectory,
        model: "reviewer-model",
        reasoningEffort: "medium",
      },
    ]),
    { workingDirectory },
  );
  const team = new CodexAgentTeam(agents);
  const starts = [];
  const codex = {
    startThread: (options) => {
      starts.push(options);
      return {
        id: `thread-${starts.length}`,
        run: async () => ({
          finalResponse:
            starts.length === 1
              ? "担当エージェントの結果"
              : "境界値を確認してください。",
        }),
      };
    },
  };
  const runner = new CodexVoiceRunner(
    {
      powerMode: true,
      peerReviewEnabled: true,
      workingDirectory,
      codexAgents: agents,
      taskModel: "fallback-model",
      taskReasoningEffort: "low",
    },
    { codex, agentTeam: team },
  );
  const task = {
    id: "assigned-issue",
    issueId: "assigned-issue",
    assignedAgentId: "builder",
    title: "実装",
    request: "修正して",
  };
  assert.equal(await runner.runTask(task), "担当エージェントの結果");
  task.result = "担当エージェントの結果";
  const review = await runner.reviewTask(task);
  assert.equal(starts[0].model, "builder-model");
  assert.equal(starts[0].modelReasoningEffort, "high");
  assert.equal(starts[1].model, "reviewer-model");
  assert.equal(starts[1].sandboxMode, "read-only");
  assert.equal(review.agentId, "reviewer");
  assert.equal(review.actionable, true);
});
