import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskUrl,
  taskMarkdown,
  taskUrl,
} from "../src/contracts/minutes.js";
test("task links round trip across projects and escape Markdown labels", () => {
  const reference = { projectId: "other-project", taskId: "task_123" };
  assert.deepEqual(parseTaskUrl(taskUrl(reference)), reference);
  assert.equal(
    taskMarkdown(reference, "[改善] *A*\nB"),
    "[\\[改善\\] \\*A\\* B](ido://projects/other-project/tasks/task_123)",
  );
});
test("task links reject untrusted schemes, paths, credentials and overlong IDs", () => {
  for (const url of [
    "javascript:alert(1)",
    "ido://projects/p/tasks/t/extra",
    "ido://projects/p/tasks/t?q=x",
    "ido://projects/p/tasks/t#x",
    "ido://projects/p/tasks/../t",
    "ido://evil@projects/p/tasks/t",
    "ido://projects/%70/tasks/t",
    `ido://projects/${"p".repeat(101)}/tasks/t`,
  ])
    assert.equal(parseTaskUrl(url), undefined, url);
  assert.throws(() => taskUrl({ projectId: "../p", taskId: "t" }));
});
