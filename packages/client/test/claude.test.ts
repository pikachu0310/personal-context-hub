import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeRuntime } from "../src/agents/claude.js";
import { claudeToolAllowed } from "../src/agents/claude-policy.js";
import { officialClaudeLoginUrl } from "../src/auth/claude.js";

test("Claude policy refuses unknown tools, escapes, planning writes and shell without network permission", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ido-claude-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work");
  const outside = join(root, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  await writeFile(join(cwd, "file"), "fixture");
  await symlink(outside, join(cwd, "escape"), "junction");
  const options = {
    workingDirectory: cwd,
    sandboxMode: "workspace-write",
    networkAccessEnabled: false,
  };
  assert.equal(
    await claudeToolAllowed("Read", { file_path: "file" }, options, true),
    true,
  );
  assert.equal(
    await claudeToolAllowed("Write", { file_path: "new/file" }, options, false),
    true,
  );
  for (const path of [
    "../outside/file",
    join(outside, "file"),
    "escape/file",
    ".git/config",
    ".claude/settings.json",
  ])
    assert.equal(
      await claudeToolAllowed("Write", { file_path: path }, options, false),
      false,
    );
  assert.equal(
    await claudeToolAllowed("Write", { file_path: "file" }, options, true),
    false,
  );
  assert.equal(
    await claudeToolAllowed("Bash", { command: "npm test" }, options, false),
    false,
  );
  assert.equal(
    await claudeToolAllowed(
      "Bash",
      { command: "npm test" },
      { ...options, networkAccessEnabled: true },
      false,
    ),
    true,
  );
  assert.equal(await claudeToolAllowed("Agent", {}, options, false), false);
});

test("Claude adapter normalizes public events, preserves sessions and queues live instructions before completion", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ido-claude-events-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const queries: any[] = [],
    approvals: string[] = [];
  const factory = ((input: any) => {
    queries.push(input);
    return {
      close() {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: "system",
          subtype: "init",
          session_id: "session-fixture",
        };
        assert.deepEqual(input.options.settingSources, []);
        assert.equal(input.options.model, "opus");
        assert.deepEqual(input.options.settings.permissions.ask, [
          "Read",
          "Glob",
          "Grep",
          "Write",
          "Edit",
          "Bash",
        ]);
        assert.equal(input.options.tools.includes("Bash"), false);
        const decision = await input.options.canUseTool("Read", {
          file_path: "file",
        });
        assert.equal(decision.behavior, "allow");
        assert.equal(
          (await input.options.canUseTool("Bash", { command: "echo test" }))
            .behavior,
          "deny",
        );
        yield {
          type: "assistant",
          session_id: "session-fixture",
          message: {
            content: [
              { type: "thinking", thinking: "private reasoning" },
              { type: "text", text: "Visible work note" },
              {
                type: "tool_use",
                id: "tool",
                name: "Read",
                input: { file_path: "file" },
              },
            ],
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool",
                content: "private file content",
              },
            ],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Finished",
          session_id: "session-fixture",
        };
      },
    };
  }) as any;
  const runtime = new ClaudeRuntime(
    {
      env: {},
      onApprovalRequest: async (method) => {
        approvals.push(method);
        return { decision: "accept" };
      },
    },
    factory,
  );
  const thread = runtime.startThread({
    model: "opus",
    workingDirectory: cwd,
    sandboxMode: "workspace-write",
    networkAccessEnabled: false,
  });
  const events: any[] = [];
  for await (const event of (
    await thread.runStreamed("Start", { signal: new AbortController().signal })
  ).events) {
    events.push(event);
    if (event.item?.text === "Visible work note" && queries.length === 1)
      assert.equal(await thread.steer("Follow up"), true);
  }
  assert.equal(queries.length, 2);
  assert.equal(queries[1].options.resume, "session-fixture");
  assert.equal(queries[1].prompt, "Follow up");
  assert.deepEqual(approvals, ["claude/Read", "claude/Read"]);
  assert.equal(
    events.filter((event) => event.type === "turn.completed").length,
    1,
  );
  assert.ok(!JSON.stringify(events).includes("private"));
  await runtime.close();
});

test("Claude rejects failed results and official auth links reject lookalike hosts", async () => {
  const runtime = new ClaudeRuntime(
    { env: {}, onApprovalRequest: async () => ({ decision: "decline" }) },
    (() => ({
      close() {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
        };
      },
    })) as any,
  );
  const thread = runtime.startThread({
    workingDirectory: tmpdir(),
    sandboxMode: "read-only",
    networkAccessEnabled: false,
  });
  await assert.rejects(async () => {
    for await (const _event of (
      await thread.runStreamed("test", { signal: new AbortController().signal })
    ).events) {
      /* consume */
    }
  }, /CLAUDE_TURN_FAILED/);
  assert.equal(
    officialClaudeLoginUrl(
      "https://claude.ai.evil.example/oauth/authorize?code=fixture \n",
    ),
    undefined,
  );
  assert.equal(
    officialClaudeLoginUrl(
      "https://claude.ai/oauth/authorize?state=fixture \n",
    ),
    "https://claude.ai/oauth/authorize?state=fixture",
  );
  await runtime.close();
});

test("Claude full access permits outside paths but still blocks edits during planning", async () => {
  const options = {
    workingDirectory: process.cwd(),
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
  };
  assert.equal(
    await claudeToolAllowed(
      "Write",
      { file_path: "../outside.txt" },
      options,
      false,
    ),
    true,
  );
  assert.equal(
    await claudeToolAllowed(
      "Write",
      { file_path: "../outside.txt" },
      options,
      true,
    ),
    false,
  );
  assert.equal(
    await claudeToolAllowed("Bash", { command: "echo test" }, options, true),
    false,
  );
});
