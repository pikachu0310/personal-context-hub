import assert from "node:assert/strict";
import test from "node:test";
import {
  canSchedule,
  evaluatePriority,
  parseTaskEvaluation,
  priorityPolicy,
  schedulingPriority,
  taskPriority,
} from "../src/processing/tasks/priority.js";
import { evaluation } from "./priority-fixture.js";

test("priority axes use the policy weights and distinguish research from executable work", () => {
  assert.equal(
    Object.values(priorityPolicy.weights).reduce<number>((a, b) => a + b, 0),
    100,
  );
  const empty = evaluation([], {
    immediacy: 0,
    certainty: 0,
    importance: 0,
    specificity: 0,
    intent: "proposal",
  });
  for (const [axis, weight] of Object.entries(priorityPolicy.weights)) {
    assert.equal(
      evaluatePriority({ ...empty, [axis]: 4 }, "research").score,
      weight,
    );
  }
  for (const kind of ["research", "implementation", "test", "benchmark"]) {
    const threshold = kind === "research" ? 25 : 40;
    for (let a = 0; a <= 4; a++)
      for (let b = 0; b <= 4; b++)
        for (let c = 0; c <= 4; c++)
          for (let d = 2; d <= 4; d++) {
            const result = evaluatePriority(
              {
                ...empty,
                immediacy: a,
                certainty: b,
                importance: c,
                specificity: d,
              },
              kind,
            );
            assert.equal(result.eligible, result.score >= threshold);
          }
  }
});
test("explicit floor requires certainty and specificity; resolution and holds win", () => {
  const low = evaluation([], { immediacy: 0, importance: 0, specificity: 2 });
  assert.equal(evaluatePriority(low, "implementation").score, 80);
  assert.equal(
    evaluatePriority({ ...low, certainty: 3 }, "implementation").eligible,
    false,
  );
  assert.equal(
    evaluatePriority({ ...low, specificity: 1 }, "research").eligible,
    false,
  );
  assert.equal(
    evaluatePriority({ ...low, resolution: "resolved" }, "research").notify,
    false,
  );
  assert.equal(
    evaluatePriority({ ...low, resolution: "unknown" }, "research").eligible,
    true,
  );
  const proposal = evaluation([], { intent: "proposal" });
  assert.equal(evaluatePriority(proposal, "implementation").eligible, true);
  assert.equal(evaluatePriority(proposal, "implementation").notify, false);
  const priority = taskPriority(low, "research", {
    batchId: "batch",
    version: 1,
    runRevision: 1,
  });
  assert.equal(
    canSchedule({
      priority: { ...priority, reason: "deferred" },
      kind: "research",
    }),
    false,
  );
  assert.equal(
    schedulingPriority({ kind: "research", trigger: "proactive" }),
    40,
  );
  assert.equal(
    schedulingPriority({ kind: "implementation", trigger: "requested" }),
    80,
  );
});
test("missing or malformed ratings are unassessed, not zero; per-axis evidence is checked", () => {
  for (const bad of [
    undefined,
    null,
    {},
    evaluation([], { immediacy: 1.5 }),
    evaluation([], { certainty: 5 }),
    evaluation([], { specificity: -1 }),
    { ...evaluation(), evidence: {} },
    { ...evaluation(), sourceIds: "bad" },
  ]) {
    assert.equal(parseTaskEvaluation(bad), null);
  }
  assert.ok(parseTaskEvaluation(evaluation(["statement"])));
  assert.equal(
    parseTaskEvaluation({ ...evaluation(["statement"]), sourceIds: [] }),
    null,
  );
});
