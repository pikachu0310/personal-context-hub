import assert from "node:assert/strict";
import test from "node:test";
import type { AdminState } from "@ido/common-ui";
import { diagnosticLines } from "../src/ui/pages/diagnostic-lines.js";

const entry = (at: number): AdminState["diagnostics"][number] => ({
  at,
  id: `error-${at}`,
  level: "error",
  source: "plugin",
  operation: "audio.transcribe",
  error: { reason: "処理に失敗しました", type: "network" },
});

test("log output limits lines rather than entries, newest first without mutating input", () => {
  const entries = Array.from({ length: 100 }, (_, i) => entry(i));
  const lines = diagnosticLines(entries);
  assert.equal(lines.length, 100);
  assert.ok(lines[2].includes("エラーID: error-99"));
  assert.ok(lines[98].includes("エラーID: error-67"));
  assert.ok(!lines.join("\n").includes("エラーID: error-0"));
  assert.equal(entries[0].at, 0);
});

test("multiline reasons and metadata count toward the same 100-line budget", () => {
  const latest = entry(2);
  latest.error.reason = Array.from(
    { length: 98 },
    (_, i) => `reason ${i}`,
  ).join("\r\n");
  latest.error.cause = "cause one\ncause two";
  const lines = diagnosticLines([entry(1), latest]);
  assert.equal(lines.length, 100);
  assert.ok(lines[99].includes("cause one"));
  assert.ok(!lines.join("\n").includes("cause two"));
  assert.ok(!lines.join("\n").includes("エラーID: error-1"));
});

test("empty logs and unknown operations remain readable", () => {
  assert.deepEqual(diagnosticLines([]), []);
  const warning = {
    ...entry(1),
    level: "warning",
    operation: "custom.operation",
  };
  const lines = diagnosticLines([warning]);
  assert.match(lines[0], /custom.operation.*一部失敗/);
  assert.equal(lines[1], "  処理に失敗しました");
});
