import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/adapters/sqlite/store.js";
import { Implementations } from "../src/processing/tasks/implementations.js";
import { MinutesDocument } from "../src/processing/minutes/document.js";
import type { Meeting } from "../src/domain/models.js";
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ido-implementations-"));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  store.put("device", "d", { id: "d", revoked: false });
  store.put("device", "other", { id: "other", revoked: false });
  store.put("project-member", "p:d", { projectId: "p", deviceId: "d" });
  store.put("project-member", "p:other", { projectId: "p", deviceId: "other" });
  store.put("project", "p", { id: "p", name: "Project" });
  for (const id of ["a", "b"])
    store.put("task", id, {
      id,
      runId: id,
      revision: 1,
      clientId: "d",
      projectId: "p",
      meetingId: "m",
      title: id,
      text: id,
      history: [],
      state: "completed",
      result: "Web implementation",
    });
  store.put("meeting", "m", {
    id: "m",
    projectId: "p",
    summary: "# 比較",
    messages: [],
  });
  const service = new Implementations(store);
  const sync = (taskId = "a", commit = "a".repeat(40)) => ({
    taskId,
    runId: taskId,
    revision: 1,
    availability: "ready",
    commit,
    branch: `refs/heads/${taskId}`,
    remote: "https://example.com/team/repo.git",
  });
  return { store, service, sync };
}
test("only assigned Clients publish; historical artifacts stay fixed and stale availability is hidden", async (t) => {
  const { store, service, sync } = await fixture(t);
  assert.throws(() => service.sync("other", sync()), /TASK_ASSIGNMENT_CHANGED/);
  assert.equal(service.sync("d", sync()).changed, true);
  assert.equal(service.sync("d", sync()).changed, false);
  const first = service.choices("p")[0].implementation!;
  service.sync("d", sync("a", "b".repeat(40)));
  assert.equal(
    service.read("other", { projectId: "p", implementationIds: [first.id] })[0]
      .commit,
    "a".repeat(40),
  );
  service.sync("d", { ...sync(), availability: "uncommitted" });
  assert.equal(service.choices("p")[0].implementation, undefined);
  assert.throws(() =>
    service.read("outsider", { projectId: "p", implementationIds: [first.id] }),
  );
  store.remove("task", "a");
  assert.throws(
    () => service.resolve("p", first.id),
    /IMPLEMENTATION_NOT_FOUND/,
  );
});
test("minutes select validated artifacts; newly available commits trigger generation without speech", async (t) => {
  const { store, service, sync } = await fixture(t);
  service.sync("d", sync());
  service.sync("d", sync("b", "b".repeat(40)));
  let calls = 0;
  const document = new MinutesDocument(
    store,
    async (_meeting, _links, _results, artifacts) => {
      calls++;
      return `# 2つの画面\n{{preview:${artifacts.map((a) => a.id).join(",")}}}`;
    },
  );
  await document.refresh("m");
  assert.match(
    store.get<Meeting>("meeting", "m")!.summary,
    /ido:\/\/projects\/p\/compare\//,
  );
  await document.refresh("m");
  assert.equal(calls, 1);
  service.sync("d", sync("b", "c".repeat(40)));
  await document.refresh("m");
  assert.equal(calls, 2);
  const previous = store.get<Meeting>("meeting", "m")!.summary;
  service.sync("d", sync("b", "d".repeat(40)));
  const invalid = new MinutesDocument(
    store,
    async () => "{{preview:invented}}",
  );
  await invalid.refresh("m");
  assert.equal(store.get<Meeting>("meeting", "m")!.summary, previous);
  assert.equal(store.get<Meeting>("meeting", "m")!.summaryState, "failed");
});
test("minutes retry if publication changes while generation is pending", async (t) => {
  const { store, service, sync } = await fixture(t);
  service.sync("d", sync());
  let calls = 0;
  const document = new MinutesDocument(store, async (_m, _l, _r, artifacts) => {
    if (++calls === 1) service.sync("d", sync("a", "b".repeat(40)));
    return `{{preview:${artifacts[0].id}}}`;
  });
  await document.refresh("m");
  assert.equal(calls, 2);
  assert.ok(
    store
      .get<Meeting>("meeting", "m")!
      .summary.includes(service.choices("p")[0].implementation!.id),
  );
});
