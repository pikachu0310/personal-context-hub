import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  CodexAgentTeam,
  parseCodexAgents,
} from "../src/discord-agent-team.mjs";

const root = resolve("test-agent-workspace");

test("Codex agent configuration validates and preserves public routing fields", () => {
  const agents = parseCodexAgents(
    JSON.stringify([
      {
        id: "frontend",
        name: "Frontend Codex",
        capabilities: ["UI", "react", "ui"],
        maximumConcurrentTasks: 1,
        workingDirectory: root,
        channelId: "11111111111111111",
        model: "gpt-test",
        reasoningEffort: "high",
      },
      {
        id: "backend",
        capabilities: ["api", "database"],
        workingDirectory: root,
      },
    ]),
    { workingDirectory: root, reasoningEffort: "medium" },
  );
  assert.equal(agents.length, 2);
  assert.deepEqual(agents[0].capabilities, ["ui", "react"]);
  assert.equal(agents[0].channelId, "11111111111111111");
  assert.equal(agents[1].name, "backend");
  assert.throws(
    () =>
      parseCodexAgents(
        JSON.stringify([
          { id: "same", workingDirectory: root },
          { id: "same", workingDirectory: root },
        ]),
        { workingDirectory: root },
      ),
    /unique/,
  );
});

test("Issues are assigned by capability and balanced by queued load", () => {
  const agents = parseCodexAgents(
    JSON.stringify([
      {
        id: "frontend",
        capabilities: ["frontend", "react", "css"],
        workingDirectory: root,
      },
      {
        id: "backend",
        capabilities: ["backend", "api", "database"],
        workingDirectory: root,
      },
    ]),
    { workingDirectory: root },
  );
  const team = new CodexAgentTeam(agents);
  const frontend = {
    id: "issue-a",
    title: "React UIを修正",
    request: "frontendのCSSを更新",
    state: "queued",
  };
  team.assign(frontend, []);
  assert.equal(frontend.issueId, "issue-a");
  assert.equal(frontend.assignedAgentId, "frontend");
  assert.match(frontend.assignmentReason, /担当領域/);

  const backend = {
    id: "issue-b",
    title: "APIを追加",
    request: "databaseへ保存するbackend API",
    state: "queued",
  };
  team.assign(backend, [frontend]);
  assert.equal(backend.assignedAgentId, "backend");

  const neutral = {
    id: "issue-c",
    title: "READMEを更新",
    request: "説明を追加",
    state: "queued",
  };
  team.assign(neutral, [frontend]);
  assert.equal(neutral.assignedAgentId, "backend");
});

test("Per-agent concurrency keeps another agent runnable", () => {
  const agents = parseCodexAgents(
    JSON.stringify([
      { id: "one", workingDirectory: root, maximumConcurrentTasks: 1 },
      { id: "two", workingDirectory: root, maximumConcurrentTasks: 1 },
    ]),
    { workingDirectory: root },
  );
  const team = new CodexAgentTeam(agents);
  const first = { id: "a", assignedAgentId: "one" };
  const second = { id: "b", assignedAgentId: "two" };
  assert.equal(team.start(first), true);
  assert.equal(team.canRun(first), false);
  assert.equal(team.canRun(second), true);
  team.finish(first);
  assert.equal(team.canRun(first), true);
  assert.equal(team.selectReviewer(first).id, "two");
});

test("online personal Workers are preferred and offline work is reassigned", () => {
  const team = new CodexAgentTeam([
    {
      id: "default",
      name: "Host Codex",
      capabilities: ["*"],
      maximumConcurrentTasks: 1,
      workingDirectory: root,
      transport: "local",
      online: true,
      enabled: true,
    },
  ]);
  team.upsert({
    id: "member-123456789012345678",
    name: "Alice Codex",
    capabilities: ["*"],
    maximumConcurrentTasks: 1,
    workingDirectory: root,
    transport: "remote",
    online: true,
    enabled: true,
  });
  const task = { id: "distributed", title: "README", request: "更新" };
  team.assign(task);
  assert.equal(task.assignedAgentId, "member-123456789012345678");
  assert.equal(task.assignedAgentTransport, "remote");
  team.setOnline(task.assignedAgentId, false);
  team.reassign(task, [], [task.assignedAgentId]);
  assert.equal(task.assignedAgentId, "default");
  assert.equal(task.assignedAgentTransport, "local");
});
