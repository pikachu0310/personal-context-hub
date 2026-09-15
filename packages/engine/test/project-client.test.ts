import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../../client/src/bootstrap/client.js";
import { Engine } from "../src/bootstrap/engine.js";
import { HttpError } from "@ido/common/runtime/http";
async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("TIMEOUT");
}
test("approved Client owns projects, invites participants, retries unknown results and fences revoked devices", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ido-client-project-"));
  const engine = new Engine({
    directory: join(dir, "engine"),
    port: 0,
    previewPort: 0,
  });
  engine.credentials.backend = "file";
  const user = engine.store.createUser(
    "member",
    "test-password-long",
    "member",
  );
  await engine.listen();
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 2; i++) {
    const c = new Client(join(dir, `client${i}`));
    c.credentials.backend = "file";
    t.mock.method(c, "checkAccount", async () => {
      c.loginStatus = "login required";
    });
    await c.start(0);
    clients.push(c);
    engine.store.put("device", `device${i}`, {
      id: `device${i}`,
      userId: user.id,
      name: "test",
      publicKey: c.settings.publicKey,
      revoked: false,
      generation: 0,
      slots: 1,
      lastAssigned: 0,
      grants: [],
    });
    c.settings.deviceId = `device${i}`;
    c.settings.engineUrl = engine.origin;
    await c.connect();
  }
  await until(() => clients.every((c) => c.connected));
  const c = clients[0];
  await c.workspaceRequest("profile", {
    avatar: "data:image/png;base64,iVBORw0KGgo=",
    name: "Alex",
    context: "バックエンド開発担当",
    codexConnected: false,
  });
  engine.store.put("meeting", "editable-minutes", {
    id: "editable-minutes",
    name: "Minutes",
    projectId: "default",
    summary: "Before",
    messages: [],
  });
  const updateMinutes = (expectedRevision: number, markdown: string) =>
    fetch(c.origin + "/api/project/minutes/update", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": c.csrf },
      body: JSON.stringify({
        projectId: "default",
        meetingId: "editable-minutes",
        expectedRevision,
        markdown,
      }),
    });
  const edited = await updateMinutes(0, "# Markdown\n\n- [x] 保存");
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).summaryRevision, 1);
  const staleMinutes = await updateMinutes(0, "stale");
  assert.equal((await staleMinutes.json()).error, "MINUTES_CONFLICT");
  const emptyTranscript = await c.workspaceRequest<any>("project.transcript", {
    projectId: "default",
  });
  assert.equal(emptyTranscript.total, 0);
  assert.deepEqual(emptyTranscript.messages, []);
  await assert.rejects(
    c.workspaceRequest("project.transcript", { projectId: "private-project" }),
    /PROJECT_INVITATION_REQUIRED/,
  );
  const minutesSnapshot = await clients[1].workspaceRequest<any>(
    "project.snapshot",
    { projectId: "default" },
  );
  assert.equal(
    minutesSnapshot.minutes.find((m: any) => m.id === "editable-minutes")
      .summary,
    "# Markdown\n\n- [x] 保存",
  );
  const defaultWorkspace = await c.workspaceRequest<any>("project.snapshot", {
    projectId: "default",
  });
  const participant = defaultWorkspace.participants.find(
    (p: any) => p.id === c.settings.deviceId,
  );
  assert.equal(participant.name, "Alex");
  assert.equal(participant.avatar, "data:image/png;base64,iVBORw0KGgo=");
  const teammateView = await clients[1].workspaceRequest<any>(
    "project.snapshot",
    { projectId: "default" },
  );
  assert.equal(
    teammateView.participants.find((p: any) => p.id === c.settings.deviceId)
      .avatar,
    participant.avatar,
  );
  assert.equal(participant.context, "バックエンド開発担当");
  assert.equal(participant.codexConnected, false);
  const post = async (name: string, directory: string) =>
    fetch(c.origin + "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": c.csrf },
      body: JSON.stringify({ name, directory }),
    });
  const path = join(dir, "new");
  await mkdir(path);
  assert.equal((await post("First", path)).status, 200);
  const project = c.settings.projects.find((p) => p.name === "First")!;
  engine.store.put("meeting", "knowledge-meeting", {
    id: "knowledge-meeting",
    name: "会議",
    projectId: project.id,
    summary: "",
    messages: [],
  });
  engine.store.put("message", "knowledge-source", {
    id: "knowledge-source",
    meetingId: "knowledge-meeting",
    authorId: "speaker",
    authorName: "参加者",
    at: Date.now(),
    text: "検索の方式を比較する",
    role: "user",
    complete: true,
    stage: "completed",
  });
  const knowledgePage = await c.workspaceRequest<any>("project.knowledge", {
    projectId: project.id,
    query: "検索",
  });
  assert.equal(knowledgePage.messages[0].id, "knowledge-source");
  await assert.rejects(
    clients[1].workspaceRequest("project.knowledge", { projectId: project.id }),
    /PROJECT_INVITATION_REQUIRED/,
  );
  assert.equal(project.ownerDeviceId, c.settings.deviceId);
  assert.equal(
    clients[1].settings.projects.some((p) => p.id === project.id),
    false,
  );
  const invitation = await c.workspaceRequest<{ token: string }>(
    "project.invite",
    { projectId: project.id },
  );
  const page = await fetch(`${engine.origin}/invite/${invitation.token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ido-agent/);
  await assert.rejects(
    clients[1].workspaceRequest("project.snapshot", { projectId: project.id }),
    /PROJECT_INVITATION_REQUIRED/,
  );
  await clients[1].workspaceRequest("project.join", {
    token: invitation.token,
  });
  await until(() =>
    clients[1].settings.projects.some((p) => p.id === project.id),
  );
  engine.store.put("task", "knowledge-task", {
    id: "knowledge-task",
    projectId: project.id,
    meetingId: "knowledge-meeting",
    clientId: c.settings.deviceId,
    runId: "knowledge-run",
    revision: 1,
    specRevision: 1,
    authorId: "speaker",
    text: "検索方式",
    title: "検索方式",
    state: "completed",
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    network: false,
  });
  const taskQuery = {
    taskId: "knowledge-task",
    runId: "knowledge-run",
    revision: 1,
    sourceIds: ["knowledge-source"],
  };
  assert.equal(
    (await c.workspaceRequest<any>("task.knowledge", taskQuery)).messages[0]
      .text,
    "検索の方式を比較する",
  );
  await assert.rejects(
    c.workspaceRequest("task.knowledge", { ...taskQuery, revision: 2 }),
    /TASK_ASSIGNMENT_CHANGED/,
  );
  await assert.rejects(
    clients[1].workspaceRequest("task.knowledge", taskQuery),
    /TASK_ASSIGNMENT_CHANGED/,
  );
  assert.ok(
    (
      await clients[1].workspaceRequest<{ token: string }>("project.invite", {
        projectId: project.id,
      })
    ).token,
  );
  await c.workspaceRequest("project.rename", {
    projectId: project.id,
    name: "Renamed",
  });
  await c.workspaceRequest("project.remove-member", {
    projectId: project.id,
    deviceId: clients[1].settings.deviceId,
  });
  await assert.rejects(
    clients[1].workspaceRequest("project.knowledge", { projectId: project.id }),
    /PROJECT_INVITATION_REQUIRED/,
  );
  await assert.rejects(
    clients[1].workspaceRequest("project.snapshot", { projectId: project.id }),
    /PROJECT_INVITATION_REQUIRED/,
  );
  await assert.rejects(
    clients[1].workspaceRequest("project.join", { token: invitation.token }),
    /NEW_INVITATION_REQUIRED/,
  );
  assert.equal(
    c.settings.mappings.find((m) => m.projectId === project.id)?.network,
    false,
  );
  assert.equal(c.allow, false);
  assert.deepEqual(
    engine.store.get<any>("device", c.settings.deviceId!).grants,
    [],
  );
  assert.equal(
    engine.store.list<any>("project").some((p) => "directory" in p),
    false,
  );
  assert.equal((await post("Renamed", path)).status, 409);
  const create = c.createProject;
  const retryPath = join(dir, "retry");
  await mkdir(retryPath);
  const uncertain = t.mock.method(
    c,
    "createProject",
    async (name: string, requestId?: string) => {
      await create(name, requestId);
      throw new HttpError(409, "PROJECT_DELIVERY_UNKNOWN");
    },
  );
  assert.equal((await post("Retry", retryPath)).status, 409);
  assert.ok(c.settings.pendingProject);
  const requestId = c.settings.pendingProject!.requestId;
  uncertain.mock.restore();
  assert.equal((await post("Retry", retryPath)).status, 200);
  assert.equal(c.settings.pendingProject, undefined);
  assert.equal(
    engine.store.list<any>("project").filter((p) => p.name === "Retry").length,
    1,
  );
  const replay = await c.createProject("Retry", requestId);
  assert.equal(replay.name, "Retry");
  const approved = engine.store.get<any>(
    "device",
    clients[1].settings.deviceId!,
  )!;
  approved.revoked = true;
  engine.store.put("device", approved.id, approved);
  await assert.rejects(
    clients[1].createProject("Denied", "new-request"),
    /PROJECT_DELIVERY_UNKNOWN/,
  );
  c.generation -= 1;
  const stale = c.createProject("Stale", "stale-request");
  await assert.rejects(stale, /PROJECT_DELIVERY_UNKNOWN/);
  assert.equal(
    engine.store
      .list<any>("project")
      .some((p) => p.name === "Stale" || p.name === "Denied"),
    false,
  );
});
