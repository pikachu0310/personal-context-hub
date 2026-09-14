import assert from "node:assert/strict";
import test from "node:test";
import { requestedVoiceModel } from "../src/engine/model-policy.mjs";
import { selectTaskProfile } from "../src/execution/codex/workspace.mjs";
import { authorizeMeetingTasks } from "../src/engine/observation/observation.mjs";

test("Astra requires an explicit participant model request, not a mention or inferred complexity", () => {
  for (const text of [
    "Astraの料金を調べて",
    "Astraで実装できる？",
    "『Astraで実装して』という文を表示して",
    "AstraとSolを比較して",
    "この難しい問題を解いて",
    "Astraを使っているか調べて",
    "Astraにしてもいい？",
  ])
    assert.notEqual(requestedVoiceModel(text)?.model, "gpt-6-astra", text);
  for (const text of [
    "Astraで実装して",
    "Astraでこのバグを直して",
    "この作業はAstraでお願いします",
    "モデルはAstra",
    "use gpt-6-astra for this task",
  ])
    assert.equal(requestedVoiceModel(text)?.model, "gpt-6-astra", text);
  for (const text of [
    "Astraは使わないで",
    "Astraでお願いしないで",
    "Astraを使ってはいけない",
    "Solで実装して",
  ])
    assert.equal(requestedVoiceModel(text)?.model, "gpt-5.6-sol", text);
  assert.equal(
    selectTaskProfile(
      { complexity: "complex" },
      { complexTaskModel: "gpt-6-astra" },
    ).model,
    "gpt-5.6-sol",
  );
  assert.equal(
    selectTaskProfile({ complexity: "routine" }, {}).modelReasoningEffort,
    "low",
  );
});

test("observer text cannot manufacture permission to use Astra", () => {
  const [task] = authorizeMeetingTasks(
    [
      {
        title: "Astraで実装して",
        kind: "implementation",
        complexity: "complex",
        sourceSequences: [1],
      },
    ],
    [{ sequence: 1, userId: "owner", text: "ボタンを大きくして" }],
    "owner",
  );
  assert.equal(selectTaskProfile(task, {}).model, "gpt-5.6-sol");
  const [explicit] = authorizeMeetingTasks(
    [{ title: "実装", sourceSequences: [1] }],
    [{ sequence: 1, userId: "owner", text: "Astraで実装して" }],
    "owner",
  );
  assert.equal(selectTaskProfile(explicit, {}).model, "gpt-6-astra");
});
