import assert from "node:assert/strict";
import test from "node:test";
import { emptyDraftState, projectDrafts } from "../src/ui/project-drafts.js";

test("leaving removes draft rows and restores only each project's text with a new ID", () => {
  let state = projectDrafts(emptyDraftState, {
    type: "open",
    projectId: "a",
    requestId: "first",
  });
  state = projectDrafts(state, { type: "leave" });
  assert.deepEqual(state, emptyDraftState);
  state = projectDrafts(state, {
    type: "open",
    projectId: "a",
    requestId: "second",
  });
  state = projectDrafts(state, {
    type: "edit",
    projectId: "a",
    text: "  unfinished\n",
  });
  state = projectDrafts(state, { type: "leave", active: "b" });
  assert.deepEqual(state.drafts, {});
  state = projectDrafts(state, {
    type: "open",
    projectId: "b",
    requestId: "third",
  });
  assert.equal(state.drafts.b.text, "");
  state = projectDrafts(state, {
    type: "open",
    projectId: "a",
    requestId: "fourth",
  });
  assert.deepEqual(state.drafts.a, {
    text: "  unfinished\n",
    requestId: "fourth",
  });
  state = projectDrafts(state, { type: "edit", projectId: "a", text: " \n " });
  state = projectDrafts(state, { type: "leave" });
  assert.deepEqual(state, emptyDraftState);
});
test("pending and uncertain submissions keep their IDs across navigation until confirmed", () => {
  let state = projectDrafts(emptyDraftState, {
    type: "open",
    projectId: "a",
    requestId: "sent",
  });
  state = projectDrafts(state, {
    type: "edit",
    projectId: "a",
    text: "request",
  });
  state = projectDrafts(state, {
    type: "sending",
    projectId: "a",
    requestId: "sent",
    text: "request",
  });
  state = projectDrafts(state, { type: "leave" });
  assert.equal(state.drafts.a.busy, true);
  state = projectDrafts(state, {
    type: "open",
    projectId: "a",
    requestId: "replacement",
  });
  assert.equal(state.drafts.a.requestId, "sent");
  state = projectDrafts(state, {
    type: "settled",
    projectId: "a",
    requestId: "sent",
  });
  assert.equal(state.drafts.a.busy, false);
  assert.equal(state.drafts.a.sentText, "request");
  assert.equal(
    projectDrafts(state, {
      type: "complete",
      projectId: "a",
      requestId: "obsolete",
    }),
    state,
  );
  state = projectDrafts(state, {
    type: "complete",
    projectId: "a",
    requestId: "sent",
  });
  assert.deepEqual(state, emptyDraftState);
});
