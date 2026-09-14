import assert from "node:assert/strict";
import test from "node:test";
import type { ClientState } from "@ido/common/contracts/api";
import { taskReadiness } from "../src/ui/task-readiness.js";
function fixture() {
  return {
    connected: true,
    loginStatus: "authenticated",
    allow: true,
    allowedProjectIds: ["other"],
    settings: {
      slots: 1,
      projects: [],
      mappings: [
        {
          projectId: "project",
          directory: "/fixture",
          network: false,
          slots: 1,
        },
      ],
    },
    runs: [],
  } as unknown as ClientState;
}
test("another project's execution permission does not hide a queued task's missing permission", () => {
  const state = fixture();
  assert.equal(
    taskReadiness(state, { projectId: "project" }).reason,
    "permission",
  );
  state.allowedProjectIds!.push("project");
  assert.equal(taskReadiness(state, { projectId: "project" }).reason, "ready");
});
test("queue guidance distinguishes missing directory, Codex, network and occupied slots", () => {
  const state = fixture();
  assert.equal(
    taskReadiness(state, { projectId: "unmapped" }).reason,
    "directory",
  );
  state.loginStatus = "login required";
  assert.equal(taskReadiness(state, { projectId: "project" }).reason, "codex");
  state.loginStatus = "authenticated";
  state.allowedProjectIds = ["project"];
  assert.equal(
    taskReadiness(state, { projectId: "project", network: true }).reason,
    "network",
  );
  state.runs = [
    { state: "interrupted", task: { projectId: "project" } },
  ] as ClientState["runs"];
  assert.equal(
    taskReadiness(state, { projectId: "project" }).reason,
    "capacity",
  );
  state.connected = false;
  assert.equal(
    taskReadiness(state, { projectId: "project" }).reason,
    "connection",
  );
});
