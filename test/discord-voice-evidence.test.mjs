import assert from "node:assert/strict";
import test from "node:test";
import {
  identifyVerificationCommand,
  formatVerificationEvidence,
} from "../src/discord-voice-evidence.mjs";
import {
  CodexVoiceRunner,
  describePowerTaskEvent,
} from "../src/discord-voice-openai.mjs";

test("verification evidence cannot mistake printed commands or masked failures for a passing check", () => {
  for (const command of [
    "echo 'npm test'",
    "printf 'node --test'",
    "node -e 'console.log(\"npm test\")'",
    "false && npm test",
    "npm test || true",
    "npm test; echo done",
    "npm test | cat",
    "npm test\necho done",
    "npm test $(printf dangerous)",
  ])
    assert.equal(identifyVerificationCommand(command, 0), undefined, command);
  assert.equal(
    identifyVerificationCommand("node --test math.test.mjs", 0).outcome,
    "passed",
  );
  assert.equal(
    identifyVerificationCommand("npm run check", 2).outcome,
    "failed",
  );
  assert.equal(
    identifyVerificationCommand(
      "/bin/bash -lc 'cd /tmp/fixture && node --test math.test.mjs'",
      0,
    ).outcome,
    "passed",
  );
  assert.equal(
    identifyVerificationCommand("cd /missing && node --test", 1).outcome,
    "unknown",
  );
  assert.equal(
    identifyVerificationCommand("pytest tests/", undefined).outcome,
    "unknown",
  );
});

test("each Codex revision records its own verification evidence and keeps unknown exits unknown", async () => {
  let turn = 0;
  const runner = new CodexVoiceRunner(
    { workingDirectory: "/tmp", powerMode: true },
    {
      codex: {
        startThread: () => ({
          id: "one-thread",
          runStreamed: async () => ({
            events: (async function* () {
              turn++;
              if (turn === 1) {
                for (const item of [
                  { command: "echo 'npm test'", exit_code: 0 },
                  { command: "node --test fixture.mjs", exit_code: 0 },
                  { command: "pytest tests/" },
                ])
                  yield {
                    type: "item.completed",
                    item: { type: "command_execution", ...item },
                  };
              }
              yield {
                type: "item.completed",
                item: { type: "agent_message", text: "完了" },
              };
              yield { type: "turn.completed" };
            })(),
          }),
        }),
      },
    },
  );
  const task = { title: "work", request: "verify" };
  await runner.runTask(task);
  const previous = structuredClone(task.evidence);
  assert.equal(previous.commands, 3);
  assert.equal(previous.tests.length, 2);
  assert.equal(previous.unknownCommands, 1);
  assert.equal(previous.failedCommands, 0);
  task.additionalInstruction = "説明だけ補足して";
  await runner.runTask(task);
  assert.equal(task.evidence.runRevision, 2);
  assert.equal(task.evidence.commands, 0);
  assert.deepEqual(task.evidence.tests, []);
  assert.equal(previous.tests[0].outcome, "passed");
});

test("verification summaries and progress never invent success for missing exit codes", () => {
  assert.match(
    describePowerTaskEvent({
      type: "item.completed",
      item: { type: "command_execution", status: "completed" },
    }),
    /不明/,
  );
  assert.doesNotMatch(
    describePowerTaskEvent({
      type: "item.completed",
      item: { type: "command_execution" },
    }),
    /終了コード: 0/,
  );
  assert.match(
    formatVerificationEvidence({
      tests: [{ command: "npm test", exitCode: 0 }],
    }),
    /終了不明 1件/,
  );
  assert.match(
    formatVerificationEvidence({
      runRevision: 2,
      tests: [
        identifyVerificationCommand("node --test", 0),
        identifyVerificationCommand("npm run check", 1),
      ],
    }),
    /成功 1件・失敗 1件[\s\S]*実行版 2/,
  );
});
