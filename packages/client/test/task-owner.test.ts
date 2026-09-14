import assert from "node:assert/strict";
import test from "node:test";
import type { ClientState } from "@ido/common/contracts/api";
import { taskOwner } from "../src/ui/task-owner.js";
const state: ClientState = {
  csrf: "fixture",
  connected: true,
  status: "connected",
  allow: true,
  loginStatus: "authenticated",
  approvals: [],
  runs: [],
  settings: {
    slots: 1,
    projects: [],
    mappings: [],
    deviceId: "self",
    identityId: "me",
    profile: { name: "Me", context: "", avatar: "self-avatar" },
  },
  teamTasks: {
    updatedAt: 0,
    total: 0,
    tasks: [],
    profiles: [{ id: "other", name: "Teammate", avatar: "other-avatar" }],
  },
};
test("owner avatars follow the assigned worker, never the request author", () => {
  assert.equal(
    taskOwner(state, { id: "t", authorId: "self", clientId: "other" })?.avatar,
    "other-avatar",
  );
  assert.equal(taskOwner(state, { id: "t" }, true)?.avatar, "self-avatar");
  assert.equal(
    taskOwner(state, {
      id: "t",
      clientId: "old",
      participants: [{ id: "old", identityId: "me", name: "Old" }],
    })?.name,
    "Me",
  );
  assert.equal(taskOwner(state, { id: "t", authorId: "self" }), undefined);
  assert.equal(
    taskOwner(state, { id: "t", clientId: "offline" }, false, "Offline worker")
      ?.name,
    "Offline worker",
  );
});
