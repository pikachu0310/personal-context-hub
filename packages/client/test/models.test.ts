import assert from "node:assert/strict";
import test from "node:test";
import {
  codexModels,
  claudeModels,
  agentCatalog,
} from "../src/agents/model-catalog.js";
import { selectedModel } from "../src/agents/model-selection.js";

test("Claude catalog initializes only the control channel and closes without submitting a prompt", async () => {
  let closed = false;
  let prompt: AsyncIterable<unknown>;
  const models = await claudeModels("unused", ".", ((input: any) => {
    prompt = input.prompt;
    assert.deepEqual(input.options.tools, []);
    assert.deepEqual(input.options.settingSources, []);
    return {
      supportedModels: async () => [
        {
          value: "account-model",
          displayName: "Account model",
          supportedEffortLevels: ["high"],
        },
      ],
      close: () => {
        closed = true;
      },
    };
  }) as any);
  assert.deepEqual(models, [
    { id: "account-model", name: "Account model", supportedEfforts: ["high"] },
  ]);
  assert.equal(closed, true);
  for await (const _value of prompt!)
    assert.fail("Catalog must never submit a turn");
});

test("catalog hides logged out agents and never uses a static fallback on failure", async () => {
  const calls: string[] = [];
  const catalog = await agentCatalog("unused", ".", {
    authenticated: async (agent) => agent === "claude",
    models: async (agent) => {
      calls.push(agent);
      throw new Error("PRIVATE_PROVIDER_DETAIL");
    },
  });
  assert.deepEqual(calls, ["claude"]);
  assert.deepEqual(catalog, [
    { agent: "codex", authenticated: false, models: [] },
    {
      agent: "claude",
      authenticated: true,
      models: [],
      error: "MODEL_LIST_UNAVAILABLE",
    },
  ]);
});

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
