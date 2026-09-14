import assert from "node:assert/strict";
import test from "node:test";
import { codexModels } from "../src/agents/model-catalog.js";
import { selectedModel } from "../src/agents/model-selection.js";

test("model selection validates identifiers and leaves defaults unset", () => {
  for (const value of [undefined, ""])
    assert.equal(selectedModel(value), undefined);
  for (const value of ["opus", "sonnet[1m]", "gpt-test", "provider/model:v1"])
    assert.equal(selectedModel(value), value);
  for (const value of [
    null,
    1,
    {},
    " model",
    "x\ncommand",
    "x;cmd",
    "x".repeat(129),
  ])
    assert.throws(() => selectedModel(value), /INVALID_MODEL/);
});

test("Codex model picker follows pagination, uses model IDs, omits hidden entries and closes", async () => {
  let calls = 0,
    closed = false;
  const values = await codexModels(
    "unused",
    () =>
      ({
        request: async (method: string, input: any) => {
          assert.equal(method, "model/list");
          calls++;
          if (calls === 1)
            return {
              data: [
                {
                  id: "picker-id",
                  model: "actual-model",
                  displayName: "Visible",
                },
                { model: "hidden-model", hidden: true },
              ],
              nextCursor: "next",
            };
          assert.equal(input.cursor, "next");
          return { data: [{ model: "other-model" }], nextCursor: null };
        },
        close: async () => {
          closed = true;
        },
      }) as any,
  );
  assert.deepEqual(values, [
    { id: "actual-model", name: "Visible" },
    { id: "other-model", name: "other-model" },
  ]);
  assert.equal(closed, true);
  closed = false;
  await assert.rejects(
    codexModels(
      "unused",
      () =>
        ({
          request: async () => {
            throw new Error("OFFLINE");
          },
          close: async () => {
            closed = true;
          },
        }) as any,
    ),
    /OFFLINE/,
  );
  assert.equal(closed, true);
});
