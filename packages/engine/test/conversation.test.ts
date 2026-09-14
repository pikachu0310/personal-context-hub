import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Task } from "@ido/common/contracts/protocol";
import { Credentials } from "@ido/common/runtime/credentials";
import { OpenAIModels } from "../src/adapters/openai/models.js";
import { Store } from "../src/adapters/sqlite/store.js";
import { Conversation } from "../src/processing/conversation.js";
test("conversation task extraction uses trusted actor and project; viewer and explicit-command processing cannot create extra tasks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-conversation-"));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const user = store.createUser("member", "test-password-long", "member"),
    viewer = store.createUser("viewer", "test-password-long", "viewer");
  store.put("project", "project", { id: "project", name: "Demo" });
  store.put("meeting", "meeting", {
    id: "meeting",
    name: "Planning",
    projectId: "project",
    summary: "",
    messages: [],
  });
  const conversation = new Conversation(
    store,
    new OpenAIModels(new Credentials(directory, "test", "file")),
  );
  (conversation.models as OpenAIModels).api = async () =>
    ({
      responses: {
        create: async () => ({
          output_text: JSON.stringify({
            minutes: "Design a page.",
            task: "Implement the page",
            projectId: "attacker-project",
            role: "admin",
            network: true,
          }),
        }),
      },
    }) as any;
  await conversation.process("meeting", user.id, "Implement the page");
  let tasks = store.list<Task>("task");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].projectId, "project");
  assert.equal(tasks[0].authorId, user.id);
  assert.equal(tasks[0].network, false);
  assert.equal(store.user(user.id)?.role, "member");
  await conversation.process("meeting", viewer.id, "Implement another page");
  await conversation.process("meeting", user.id, "Explicit task command", null);
  tasks = store.list<Task>("task");
  assert.equal(tasks.length, 1);
});
