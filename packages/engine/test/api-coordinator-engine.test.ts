import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Engine } from "../src/bootstrap/engine.js";
import type { InputContext } from "@ido/common/contracts/plugins";

test("default Engine answers, restores local history and delegates work using only API requests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-api-engine-"));
  let engine = new Engine({ directory });
  t.after(async () => {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  });
  const requests: any[] = [],
    replies: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    assert.equal(
      input instanceof Request ? input.url : String(input),
      "https://api.openai.com/v1/responses",
    );
    const request = JSON.parse(
      input instanceof Request ? await input.text() : init.body,
    );
    if (request.instructions?.startsWith("日本語の議事録")) {
      assert.equal(request.store, false);
      assert.deepEqual(request.tools, []);
      const minutes = JSON.parse(request.input);
      return new Response(
        JSON.stringify({
          id: "resp_minutes",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: [
                    minutes.previousMinutes,
                    ...minutes.messages.map((m: any) => `- ${m.text}`),
                  ]
                    .filter(Boolean)
                    .join("\n"),
                  annotations: [],
                },
              ],
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    requests.push(request);
    const observation = JSON.parse(request.input.split("\n").at(-1));
    const sourceIds = observation.events
      .filter((event: any) => event.type === "message")
      .map((event: any) => event.source.id);
    const result =
      requests.length === 3
        ? {
            reply: null,
            tasks: [
              {
                title: "依頼された変更",
                kind: "implementation",
                sourceIds,
                acceptanceCriteria: [],
              },
            ],
            controls: [],
          }
        : {
            reply: {
              text: `回答${requests.length}`,
              reason: "direct_answer",
              sourceIds,
            },
            tasks: [],
            controls: [],
          };
    return new Response(
      JSON.stringify({
        id: "resp_fixture",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: JSON.stringify(result),
                annotations: [],
              },
            ],
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  await engine.credentials.set("openai", "fixture-key");
  engine.store.put("participant", "actor", {
    id: "actor",
    name: "利用者",
    role: "member",
  });
  engine.store.put("project", "project", {
    id: "project",
    name: "Project",
    remote: "",
  });
  engine.store.put("meeting", "meeting", {
    id: "meeting",
    name: "Meeting",
    projectId: "project",
    summary: "",
    messages: [],
  });
  const send = async (
    id: string,
    text: string,
    command: "ask" | "task" = "ask",
  ) => {
    const context: InputContext = {
      pluginId: "fixture",
      actor: engine.store.conversationAuthor("actor")!,
      valid: () => true,
      deliver: async (output) => {
        if (output.content) replies.push(output.content);
      },
      publish: () => {},
    };
    await engine.input.handle(
      {
        eventId: id,
        meetingId: "meeting",
        projectId: "project",
        text,
        command,
        interaction: true,
      },
      context,
    );
    await engine.conversation.coordinated!.flush("meeting");
    await engine.conversation.document.refresh("meeting");
  };
  await send("first", "前提を覚えて説明してください");
  assert.ok(
    replies.includes("回答1"),
    JSON.stringify({
      replies,
      diagnostics: engine.store.diagnostics(),
      requests: requests.length,
    }),
  );
  assert.equal(engine.store.diagnostics().length, 0);
  await engine.close();
  engine = new Engine({ directory });
  await send("second", "前の回答を補足してください");
  const next = JSON.parse(requests[1].input.split("\n").at(-1));
  assert.match(next.context, /前提を覚えて/);
  assert.match(next.context, /回答1/);
  assert.ok(!next.context.includes("前の回答を補足"));
  await send("third", "この変更を実装してください", "task");
  assert.equal(engine.store.list("task").length, 1);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.store, false);
    assert.deepEqual(request.tools, []);
  }
  assert.ok(!(await readdir(directory)).includes("codex"));
  assert.ok(!(await readdir(directory)).includes("coordinator-workspace"));
});

test("upgrading a saved uncertain Codex batch preserves recovery and never sends it automatically", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-api-recovery-"));
  const engine = new Engine({ directory });
  t.after(async () => {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async () => {
    assert.fail("uncertain input was replayed");
  });
  engine.store.put("meeting", "meeting", {
    id: "meeting",
    name: "Meeting",
    summary: "",
    messages: [],
  });
  engine.store.put("coordinator", "meeting", {
    mode: "text-speech",
    modeRevision: 0,
    inbox: {
      handle: {
        backend: "codex",
        meetingId: "meeting",
        threadId: "old-thread",
      },
      active: { id: "old-batch", status: "uncertain", events: [] },
      pending: [],
    },
  });
  assert.equal(
    engine.conversation.coordinated!.state("meeting").uncertain,
    true,
  );
  assert.equal(await engine.conversation.coordinated!.flush("meeting"), false);
  assert.equal(
    engine.conversation.coordinated!.state("meeting").batchId,
    "old-batch",
  );
});
