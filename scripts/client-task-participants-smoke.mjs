// Synthetic Engine data and production Client components; no external accounts.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { Store } from "../packages/engine/src/adapters/sqlite/store.ts";
import { taskSnapshot } from "../packages/engine/src/adapters/client-ws/task-list.ts";
import { Scheduler } from "../packages/engine/src/clients/scheduler.ts";
import { Projects } from "../packages/engine/src/processing/projects/service.ts";
import { ProjectTeam } from "../packages/engine/src/processing/projects/team.ts";
import { WorkspaceLifecycle } from "../packages/engine/src/processing/projects/lifecycle.ts";
import { createWorkPort } from "../packages/engine/src/processing/tasks/work.ts";
import { taskParticipants } from "../packages/engine/src/processing/projects/task-participants.ts";

const directory = await mkdtemp(join(tmpdir(), "ido-participant-browser-"));
const store = new Store(directory);
let browser;
try {
  const projects = new Projects(store);
  projects.ensure();
  const project = projects.create("Fixture project", "project-request");
  const team = new ProjectTeam(store);
  const user = store.createUser("Fixture member", "fixture-password", "member");
  const publicKey = generateKeyPairSync("ed25519")
    .publicKey.export({ format: "pem", type: "spki" })
    .toString();
  const avatar =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  for (const id of ["worker", "worker-copy", "guest"]) {
    store.put("device", id, {
      id,
      userId: user.id,
      publicKey: id === "guest" ? "fixture-key" : publicKey,
      name: id,
      generation: 1,
      revoked: false,
      slots: 1,
      lastAssigned: 0,
      grants: [{ projectId: project.id, network: false, slots: 1 }],
    });
    team.profile(id, {
      name: id === "guest" ? "Sam" : "Alex",
      avatar,
      codexConnected: true,
    });
    team.join(id, project.id);
  }
  for (const id of ["discord-100", "discord-200"])
    store.put("participant", id, {
      id,
      name: "Discord speaker",
      role: "member",
    });
  const work = createWorkPort({ repository: store });
  const task = work.submit({
    sourcePluginId: "discord",
    requestKey: "task",
    projectId: project.id,
    meetingId: projects.current(project.id).meetingId,
    authorId: "discord-100",
    request: "ログイン画面を作成してください",
    sourceStatements: [
      { authorId: "discord-200", text: "Source conversation" },
    ],
  });
  const cases = [];
  const capture = (label, sender) => {
    const current = store.get("task", task.id);
    const participants = taskParticipants(store, current, true);
    cases.push({
      label,
      task: { ...current, participants },
      sender,
      state: {
        settings: {
          deviceId: "worker",
          identityId: participants.find((p) => p.id === "worker")?.identityId,
          profile: { name: "Alex", avatar },
        },
        projectTasks: team.snapshot("worker", project.id).tasks,
        teamTasks: taskSnapshot(store, new Map(), new Set([project.id])),
      },
    });
  };
  capture("queued");
  new Scheduler(store).schedule(new Set(["worker"]));
  capture("assigned");
  const receipt = work.control({
    sourcePluginId: "discord",
    taskId: task.id,
    authorId: "discord-200",
    type: "instruction",
    instruction: "青色に変更してください",
    requestKey: "instruction",
  });
  const sender = store
    .pending("worker")
    .find((c) => c.receiptId === receipt.id).sender;
  capture("instruction", sender);
  const lifecycle = new WorkspaceLifecycle(store);
  for (const deviceId of ["worker-copy", "guest"])
    lifecycle.membership(
      { deviceId, valid: () => true },
      task.id,
      true,
      store.get("task", task.id).membershipVersion,
    );
  capture("joined", sender);
  const { outputFiles } = await build({
    stdin: {
      contents: `import React from "react";
        import { createRoot } from "react-dom/client";
        import { TaskAvatars } from "./packages/client/src/ui/TaskAvatars.tsx";
        import { TaskOwner } from "./packages/client/src/ui/TaskOwner.tsx";
        import { RequestMessage } from "./packages/client/src/ui/ActivityFeed.tsx";
        import { initialSender } from "./packages/client/src/ui/chat-presentation.ts";
        const cases = ${JSON.stringify(cases)};
        createRoot(document.getElementById("root")).render(<main>{cases.map(({ label, task, state, sender }) =>
          <section key={label} data-testid={label}><h2>{label}</h2>
            <div className="summary"><TaskAvatars state={{...state,projectTasks:undefined}} task={state.teamTasks.tasks[0]} /></div>
            <div className="detail"><TaskAvatars state={state} task={task} /><TaskOwner state={state} task={task} /></div>
            <RequestMessage text={task.initialText ?? task.text} sender={initialSender(task, false, state)} />
            {sender && <RequestMessage text="青色に変更してください" sender={sender} />}
          </section>)}</main>);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(
    '<html><head></head><body><div id="root"></div></body></html>',
  );
  await page.addStyleTag({
    content: `body { font-family:sans-serif; margin:16px; --workspace-muted:#677080; --workspace-soft:#f3f4f6; --workspace-border:#ddd; } section { border:1px solid #ddd; padding:16px; margin-bottom:16px; } ${await readFile("packages/client/src/ui/workspace.css", "utf8")}`,
  });
  await page.addScriptTag({ content: outputFiles[0].text });
  for (const [label, expected] of [
    ["queued", "idobot"],
    ["assigned", "Alex、idobot"],
    ["instruction", "Alex、idobot"],
    ["joined", "Alex、Sam、idobot"],
  ]) {
    const section = page.getByTestId(label);
    await section
      .getByRole("img", { name: `参加者: ${expected}`, exact: true })
      .first()
      .waitFor();
    assert.equal(
      await section
        .getByRole("img", { name: `参加者: ${expected}`, exact: true })
        .count(),
      2,
    );
    if (label !== "queued") {
      assert.equal(await section.locator(".task-owner").innerText(), "Alex");
      assert.equal(
        await section.locator(".task-owner img").getAttribute("src"),
        avatar,
      );
      assert.equal(
        await section
          .locator(".summary .user-avatar img")
          .first()
          .getAttribute("src"),
        avatar,
      );
    }
    for (const message of await section.locator(".request-message").all())
      assert.match(
        await message.locator(".request-avatar").getAttribute("aria-label"),
        /idobot/i,
      );
    assert.doesNotMatch(
      await section.innerText(),
      /Discord speaker|Source conversation/,
    );
  }
  await mkdir(".ido-build/screenshots", { recursive: true });
  for (const width of [1000, 375]) {
    await page.setViewportSize({ width, height: 1200 });
    await page.screenshot({
      path: `.ido-build/screenshots/client-task-participants-${width}.png`,
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  console.log(
    "Task participant browser smoke passed: queued/assigned bot membership, summary/detail consistency, avatar, identity grouping and Discord instruction sender.",
  );
} finally {
  await browser?.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
