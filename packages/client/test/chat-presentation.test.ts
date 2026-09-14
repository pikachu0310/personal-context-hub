import assert from "node:assert/strict";
import test from "node:test";
import type { ClientActivity, ClientState } from "@ido/common/contracts/api";
import type { Task } from "@ido/common/contracts/protocol";
import {
  initialSender,
  displaySender,
  showStart,
} from "../src/ui/chat-presentation.js";

const state = {
  settings: {
    deviceId: "self",
    identityId: "identity",
    profile: { name: "Me" },
  },
} as ClientState;
const entry = (overrides: Partial<ClientActivity> = {}): ClientActivity => ({
  id: "1:start",
  revision: 1,
  at: 60_000,
  updatedAt: 60_000,
  kind: "status",
  title: "作業を開始",
  ...overrides,
});
test("start timing uses each request, including retries and instructions", () => {
  for (const seconds of [59, 60, 61])
    assert.equal(
      showStart(entry({ at: seconds * 1000 }), 0, []),
      seconds >= 60,
    );
  assert.equal(
    showStart(entry({ revision: 2, requestAt: 59_000 }), 0, []),
    false,
  );
  assert.equal(showStart(entry({ revision: 2 }), 0, []), true);
  assert.equal(showStart(entry(), undefined, []), true);
  assert.equal(
    showStart(entry({ id: "1:instruction-start:a", requestAt: 1_000 }), 0, []),
    false,
  );
  assert.equal(
    showStart(entry({ id: "1:instruction-start:b", requestAt: 0 }), 0, []),
    true,
  );
  assert.equal(
    showStart(entry({ id: "1:instruction-start:legacy" }), 0, []),
    true,
  );
});
test("sender uses authorship rather than worker assignment", () => {
  const task = {
    authorId: "other",
    clientId: "self",
    participants: [{ id: "other", name: "Other" }],
  } as Task;
  assert.equal(initialSender(task, false, state)?.name, "Other");
  assert.equal(
    initialSender({ ...task, createdByBot: true }, false, state)?.bot,
    true,
  );
  assert.equal(
    initialSender({ ...task, authorId: "missing" }, false, state),
    undefined,
  );
  assert.equal(
    initialSender({ ...task, authorId: "client-self" }, false, state)?.name,
    "Me",
  );
  assert.equal(
    displaySender(
      { id: "old-device", identityId: "identity", name: "Old" },
      state,
    )?.name,
    "Me",
  );
  assert.equal(displaySender(undefined, state), undefined);
});
