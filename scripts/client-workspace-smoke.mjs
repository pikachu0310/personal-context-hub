// Real Client routes and executor, synthetic Codex responses; no account login,
// remote Engine, Discord message, or model request is made by this smoke test.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { Client } from "../packages/client/dist/index.js";

const directory = await mkdtemp(join(tmpdir(), "ido-workspace-ui-"));
const client = new Client(join(directory, "client"));
const catalogAgents = [
  {
    agent: "codex",
    authenticated: true,
    models: [
      {
        id: "test-codex-model",
        name: "Test Codex",
        supportedEfforts: ["low", "high"],
        defaultEffort: "low",
      },
    ],
  },
  {
    agent: "claude",
    authenticated: true,
    models: [{ id: "opus", name: "Test Claude" }],
  },
];
client.agentCatalog = async () => catalogAgents;
client.credentials.backend = "file";
let browser, running, release;
const steers = [];
let turn = 0;
try {
  const repository = join(directory, "repo");
  await mkdir(repository);
  const git = (...args) =>
    execFileSync("git", ["-C", repository, ...args], {
      windowsHide: true,
      stdio: "pipe",
    });
  git("init");
  await writeFile(join(repository, "forum.ts"), "export const sync = false;\n");
  git("add", "forum.ts");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Fixture",
  );
  await writeFile(join(repository, "forum.ts"), "export const sync = true;\n");
  await client.start(0);
  client.settings.projects = [
    { id: "project", name: "discord-voice", remote: "" },
    { id: "tools", name: "team-tools", remote: "" },
  ];
  client.settings.mappings = [
    { projectId: "project", directory: repository, network: false, slots: 1 },
  ];
  client.settings.profile = {
    name: "Demo user",
    context: "フォームのエラーは日本語で説明してください。",
  };
  client.connected = true;
  client.controlSupported = true;
  client.allowedProjects.add("project");
  client.settings.deviceId = "local-device";
  client.settings.identityId = "client:" + "a".repeat(64);
  client.teamTasksSupported = true;
  client.teamTasks = {
    updatedAt: Date.now(),
    total: 3,
    tasks: [
      {
        id: "historical-self",
        runId: "historical-run",
        revision: 1,
        projectId: "project",
        title: "以前の自分のタスク",
        state: "completed",
        clientId: "old-device",
        clientIdentityId: client.settings.identityId,
        participants: [
          {
            id: "old-device",
            identityId: client.settings.identityId,
            name: "Old profile",
          },
          {
            id: "local-device",
            identityId: client.settings.identityId,
            name: "Current profile",
          },
        ],
        ownerName: "Old profile",
        updatedAt: Date.now(),
      },
      {
        id: "remote-task",
        runId: "remote-run",
        revision: 1,
        projectId: "project",
        title: "共有ルーティングを確認",
        state: "running",
        clientId: "other-device",
        participants: [
          { id: "other-device", name: "Demo teammate" },
          { id: "member-two", name: "Alex" },
          { id: "member-three", name: "Sam" },
          { id: "member-four", name: "Taylor" },
          { id: "idobot", name: "idobot", bot: true },
        ],
        ownerName: "Demo teammate",
        deviceName: "Demo Mac",
        deviceConnected: true,
        progress: "ルーティングのテストを実行中です。",
        updatedAt: Date.now(),
      },
      {
        id: "queued-task",
        runId: "queued-run",
        revision: 1,
        projectId: "project",
        title: "未割り当ての依頼",
        state: "queued",
        updatedAt: Date.now(),
      },
    ],
  };
  const thread = {
    activeTurnId: null,
    async steer(text) {
      steers.push(text);
      return true;
    },
    async runStreamed(prompt, options) {
      if (turn === 0) {
        assert.match(prompt, /フォームのエラーは日本語で説明/);
        assert.match(prompt, /既存のスレッドとの対応を維持/);
      }
      return {
        events: (async function* () {
          const n = ++turn;
          thread.activeTurnId = `turn-${n}`;
          yield { type: "thread.started", thread_id: "fixture-thread" };
          yield { type: "turn.started" };
          yield {
            type: "item.completed",
            item: {
              type: "agent_message",
              id: `note-${n}`,
              phase: "commentary",
              text:
                options.collaborationMode === "plan"
                  ? "既存のタスクとフォーラムの対応を確認します。\n状態の更新と追加指示の配送を、同じスレッドにまとめる方針です。"
                  : "合意した計画に沿って進めています。\n**権限の設定は維持**し、フォーラムとの同期部分を確認します。",
            },
          };
          yield {
            type: "item.completed",
            item: {
              type: "command_execution",
              id: `command-${n}`,
              command: "npm run test -- forum",
              aggregated_output:
                "Fixture output: 12 tests passed\nNo duplicate threads",
              exit_code: 0,
              status: "completed",
            },
          };
          if (options.collaborationMode === "default") {
            yield {
              type: "item.completed",
              item: {
                type: "file_change",
                id: "files",
                status: "completed",
                changes: [{ path: "forum.ts", kind: "update" }],
              },
            };
            await new Promise((resolve) => {
              release = resolve;
            });
          }
          yield {
            type: "item.completed",
            item: {
              type: "agent_message",
              id: `answer-${n}`,
              phase:
                options.collaborationMode === "plan" ? "plan" : "final_answer",
              text:
                options.collaborationMode === "plan"
                  ? "次の手順で進めます。\n\n- タスクごとのスレッド対応を保持する\n- 状態の更新と追加指示を同期する\n- 再起動後の重複作成をテストする\n\n確認したいことがあれば、そのまま会話を続けてください。"
                  : "表示確認用の実行結果です。",
            },
          };
          thread.activeTurnId = null;
          yield { type: "turn.completed" };
        })(),
      };
    },
  };
  client.executor.createCodex = () => ({
    startThread: () => thread,
    close: async () => {
      release?.();
    },
  });
  const task = {
    id: "task",
    runId: "run",
    revision: 1,
    specRevision: 1,
    state: "assigned",
    projectId: "project",
    meetingId: "meeting",
    authorId: "member",
    createdByBot: true,
    requestId: "request",
    title: "Discordフォーラムの同期を整える",
    text: "フォーラムのスレッドとタスクを同期したい。\nまず方針を相談してから実装を進めよう。",
    network: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [],
    sourceStatements: [
      {
        id: "source-1",
        meetingId: "meeting",
        sequence: 1,
        speakerName: "Demo teammate",
        text: "決定: 既存のスレッドとの対応を維持する。\n担当: Demo user",
      },
    ],
  };
  const value = {
    task,
    directory: repository,
    state: "assigned",
    progressMode: "manual",
  };
  client.executor.runs.run = value;
  for (const [id, title, projectId] of [
    ["install", "アプリのインストール案内を更新", "project"],
    ["mac", "Macの接続手順を確認", "project"],
    ["notes", "議事録の整理方法を検討", "tools"],
  ])
    client.executor.runs[id] = {
      task: { ...task, id, runId: id, title, projectId },
      directory: repository,
      state: "completed",
      result: "表示確認用の過去タスクです。",
    };
  running = client.executor
    .execute(value, client.settings.mappings[0], false)
    .catch(() => {});
  client.executor.running.set("run", running);
  client.control = async (runId, requestKey, instruction) => {
    await client.executor.receive(
      {
        v: 1,
        type: "steer",
        id: requestKey,
        taskId: "task",
        runId,
        revision: 1,
        text: instruction,
      },
      client.settings.mappings,
      true,
      1,
    );
    return { accepted: true };
  };
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1360, height: 980 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(client.origin);
  await page.getByRole("button", { name: "実行する", exact: true }).waitFor();
  await page.getByLabel("入力欄のモデル").selectOption("test-codex-model");
  await page.getByLabel("入力欄の推論エフォート").selectOption("high");
  await page.waitForFunction(
    () =>
      !globalThis.document.querySelector('[aria-label="入力欄のモデル"]')
        .disabled,
  );
  const configured = Object.values(client.executor.runs).find(
    (run) => run.reasoningEffort === "high",
  );
  assert.equal(configured.model, "test-codex-model");
  assert.equal(
    await page.getByText("次の実行ターンから適用", { exact: true }).count(),
    0,
  );
  const originalAccess = configured.accessMode;
  for (const mode of ["auto", "manual"]) {
    const response = page.waitForResponse((value) =>
      value.url().endsWith("/api/progress-mode"),
    );
    await page.getByLabel("入力欄の進め方").selectOption(mode);
    assert.equal((await response).status(), 200);
    assert.equal(
      configured.pendingProgressMode ?? configured.progressMode,
      mode,
    );
  }
  assert.equal(configured.accessMode, originalAccess);
  const projectToggle = page.locator(
    '[data-project-id="project"] > .project-collapse > .collapse-heading > button',
  );
  await projectToggle.click();
  assert.equal(await projectToggle.getAttribute("aria-expanded"), "false");
  await page.reload();
  assert.equal(await projectToggle.getAttribute("aria-expanded"), "false");
  await projectToggle.click();
  assert.equal(
    await page.locator("html").getAttribute("data-mantine-color-scheme"),
    "light",
  );
  const inspector = page.getByRole("complementary", { name: "タスクの詳細" });
  await page.evaluate(() => globalThis.document.fonts.ready);
  assert.ok(
    await page.evaluate(() =>
      globalThis.document.fonts.check('15px "Noto Sans JP Variable"', "議事録"),
    ),
  );
  assert.ok((await page.locator(".tabler-icon").count()) > 10);
  const panelToggle = page.getByRole("button", {
    name: "タスクの詳細",
    exact: true,
  });
  const samplePanelMotion = () =>
    page.evaluate(async () => {
      const chat = globalThis.document.querySelector(".task-conversation");
      const panel = globalThis.document.querySelector(".task-inspector");
      const widths = [chat.getBoundingClientRect().width];
      const transforms = [globalThis.getComputedStyle(panel).transform];
      globalThis.document.querySelector(".inspector-header-toggle").click();
      const start = globalThis.performance.now();
      await new Promise((resolve) => {
        const frame = () => {
          widths.push(chat.getBoundingClientRect().width);
          transforms.push(globalThis.getComputedStyle(panel).transform);
          if (globalThis.performance.now() - start >= 400) resolve();
          else globalThis.requestAnimationFrame(frame);
        };
        globalThis.requestAnimationFrame(frame);
      });
      return { widths, transforms };
    });
  const closingMotion = await samplePanelMotion();
  const closedWidth = closingMotion.widths.at(-1);
  const openWidth = closingMotion.widths[0];
  assert.ok(closedWidth - openWidth > 300);
  assert.ok(
    closingMotion.widths.some(
      (width) => width > openWidth + 3 && width < closedWidth - 3,
    ),
  );
  assert.ok(new Set(closingMotion.transforms).size > 2);
  await inspector.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".task-inspector").getAttribute("inert"), "");
  assert.equal(await panelToggle.getAttribute("aria-expanded"), "false");
  const openingMotion = await samplePanelMotion();
  assert.ok(Math.abs(openingMotion.widths.at(-1) - openWidth) < 1);
  assert.ok(
    openingMotion.widths.some(
      (width) => width > openWidth + 3 && width < closedWidth - 3,
    ),
  );
  await inspector.waitFor();
  await page.evaluate(async () => {
    for (let index = 0; index < 4; index++) {
      globalThis.document.querySelector(".inspector-header-toggle").click();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 45));
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 350));
  });
  assert.equal(await panelToggle.getAttribute("aria-expanded"), "true");
  assert.ok(
    Math.abs(
      (await page.locator(".task-conversation").boundingBox()).width -
        openWidth,
    ) < 1,
  );
  assert.equal(await inspector.getAttribute("data-collapsed"), null);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await panelToggle.click();
  await page.waitForFunction(() =>
    globalThis.document
      .querySelector(".task-inspector")
      .hasAttribute("data-collapsed"),
  );
  assert.equal(
    await page
      .locator(".with-inspector")
      .evaluate(
        (element) => globalThis.getComputedStyle(element).transitionDuration,
      ),
    "0s",
  );
  assert.equal(
    await page
      .locator(".task-inspector")
      .evaluate(
        (element) => globalThis.getComputedStyle(element).transitionDuration,
      ),
    "0s",
  );
  await panelToggle.click();
  await inspector.waitFor();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const scrollLayout = await page
    .locator(".with-inspector")
    .evaluate((element) => ({
      outer: globalThis.getComputedStyle(element).overflowY,
      inner: globalThis.getComputedStyle(
        element.querySelector(".conversation-scroll"),
      ).overflowY,
      right: element.getBoundingClientRect().right,
      inspectorRight: element
        .querySelector(".task-inspector")
        .getBoundingClientRect().right,
    }));
  assert.equal(scrollLayout.outer, "auto");
  assert.equal(scrollLayout.inner, "visible");
  assert.ok(scrollLayout.right > scrollLayout.inspectorRight);
  const conversation = await page.locator(".task-conversation").boundingBox();
  const inspectorBox = await inspector.boundingBox();
  assert.ok(inspectorBox.x >= conversation.x + conversation.width);
  await inspector.getByText(repository, { exact: true }).waitFor();
  const environmentResponse = await page.request.get(
    `${client.origin}/api/task-environment?runId=run`,
  );
  const environment = await environmentResponse.json();
  assert.equal(
    environment.branch,
    git("branch", "--show-current").toString().trim(),
  );
  assert.equal(environment.directory, repository);
  assert.equal(environment.ownerName, "Demo user");
  assert.ok(environment.deviceName);
  git("checkout", "--detach");
  const detached = await (
    await page.request.get(`${client.origin}/api/task-environment?runId=run`)
  ).json();
  assert.equal(detached.branch, undefined);
  assert.equal(detached.commit, git("rev-parse", "HEAD").toString().trim());
  git("checkout", environment.branch);
  await inspector
    .getByRole("button", { name: "環境を更新", exact: true })
    .click();
  assert.equal(
    (
      await page.request.get(
        `${client.origin}/api/task-environment?runId=missing`,
      )
    ).status(),
    404,
  );
  await inspector.getByRole("tab", { name: "ソース", exact: true }).click();
  await inspector
    .getByRole("button", { name: "議事録 · Demo teammate", exact: true })
    .click();
  await inspector.getByText(/決定: 既存のスレッドとの対応を維持/).waitFor();
  await inspector
    .getByRole("button", { name: "Demo userのユーザー情報", exact: true })
    .click();
  await inspector
    .getByText("フォームのエラーは日本語で説明してください。", { exact: true })
    .waitFor();
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-sources.png",
  });
  await inspector.getByRole("tab", { name: "環境", exact: true }).click();
  await inspector.getByRole("tab", { name: "ソース", exact: true }).click();
  await inspector
    .getByRole("button", { name: "議事録 · Demo teammate", exact: true })
    .click();
  await page
    .getByRole("button", { name: "@ユーザー情報", exact: true })
    .click();
  await inspector
    .getByText("フォームのエラーは日本語で説明してください。", { exact: true })
    .waitFor();
  await inspector.getByRole("tab", { name: "環境", exact: true }).click();
  await inspector
    .getByRole("button", { name: "ソースを追加", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "共有コンテキスト", exact: true })
    .click();
  const sourceDialog = page.getByRole("dialog", {
    name: "共有コンテキストを追加",
    exact: true,
  });
  await sourceDialog.getByLabel(/^タイトル/).fill("UI追加資料");
  await sourceDialog.getByLabel(/^内容/).fill("追加した資料の保存を確認");
  await sourceDialog
    .getByRole("button", { name: "追加する", exact: true })
    .click();
  await sourceDialog.waitFor({ state: "hidden" });
  await inspector
    .getByRole("button", { name: "UI追加資料", exact: true })
    .click();
  await inspector
    .getByText("追加した資料の保存を確認", { exact: true })
    .waitFor();
  await page.reload();
  await inspector
    .getByRole("button", { name: "UI追加資料", exact: true })
    .waitFor();
  await inspector.getByRole("tab", { name: "環境", exact: true }).click();
  const schemeIs = (scheme) =>
    page.waitForFunction(
      (expected) =>
        globalThis.document.documentElement.dataset.mantineColorScheme ===
        expected,
      scheme,
    );
  const lightCanvas = await page
    .locator(".workspace-main")
    .evaluate(
      (element) => globalThis.getComputedStyle(element).backgroundColor,
    );
  await page.emulateMedia({ colorScheme: "dark" });
  await schemeIs("dark");
  const darkCanvas = await page
    .locator(".workspace-main")
    .evaluate(
      (element) => globalThis.getComputedStyle(element).backgroundColor,
    );
  assert.notEqual(darkCanvas, lightCanvas);
  await page.getByRole("button", { name: "ユーザー設定を開く" }).click();
  await page.getByRole("dialog").getByText("ダーク", { exact: true }).click();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("ido.color-scheme")),
    "dark",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal(
    await page.locator("html").getAttribute("data-mantine-color-scheme"),
    "dark",
  );
  await page.reload();
  await page.getByRole("button", { name: "実行する", exact: true }).waitFor();
  await schemeIs("dark");
  await page.screenshot({ path: ".ido-build/screenshots/workspace-dark.png" });
  await page.getByRole("button", { name: "ユーザー設定を開く" }).click();
  await page.getByRole("dialog").getByText("ライト", { exact: true }).click();
  await schemeIs("light");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("ido.color-scheme")),
    "light",
  );
  await page.getByRole("dialog").getByText("システム", { exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await schemeIs("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await schemeIs("light");
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-appearance-settings.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    await page
      .locator('.task-row[data-task-id="task"] .task-indicator.running')
      .count(),
    1,
  );
  assert.equal(await page.locator(".avatar-overflow").innerText(), "+2");
  assert.ok((await page.locator(".task-avatars .bot-avatar").count()) > 0);
  const historical = page.locator('.task-row[data-task-id="historical-self"]');
  await historical
    .getByRole("img", { name: "未確認の結果", exact: true })
    .waitFor();
  assert.equal(await historical.locator(".user-avatar").count(), 1);
  assert.equal(
    await historical.locator(".task-avatars").getAttribute("aria-label"),
    "参加者: Demo user",
  );
  await historical.locator(".task-link").click();
  await historical.locator(".task-indicator").waitFor({ state: "hidden" });
  await page
    .getByRole("heading", { name: "以前の自分のタスク", level: 2, exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "タスクを停止", exact: true })
      .count(),
    0,
  );
  assert.equal(client.teamTasks.tasks[0].clientId, "old-device");
  await page
    .locator('.task-row[data-task-id="remote-task"] .task-link')
    .click();
  await page
    .getByText("ルーティングのテストを実行中です。", { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("エージェントへの追加指示").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "タスクを停止", exact: true })
      .count(),
    0,
  );
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-team-tasks.png",
  });
  await page
    .locator('.task-row[data-task-id="queued-task"] .task-link')
    .click();
  await page
    .getByText("実行先が決まると、このPCまたはほかのPCの一覧へ移動します。", {
      exact: true,
    })
    .waitFor();
  await page.reload();
  await page.getByRole("button", { name: "実行する", exact: true }).waitFor();
  assert.equal(await historical.locator(".task-indicator").count(), 0);
  client.teamTasks.tasks[0].revision++;
  await page.getByRole("button", { name: "最新の状態に更新" }).click();
  await historical
    .getByRole("img", { name: "未確認の結果", exact: true })
    .waitFor();
  await historical.locator(".task-link").click();
  await historical.locator(".task-indicator").waitFor({ state: "hidden" });
  const voiceGroup = page.locator('.project-group[data-project-id="project"]');
  const toolsGroup = page.locator('.project-group[data-project-id="tools"]');
  for (const project of [voiceGroup, toolsGroup]) {
    assert.equal(await project.locator(".project-tasks").count(), 1);
    assert.equal(
      await project.locator(".sidebar-caption, .shared-task-owner").count(),
      0,
    );
  }
  assert.equal(
    await page
      .locator('.task-row[data-task-id="queued-task"] .task-indicator')
      .count(),
    0,
  );
  const rowBox = await historical.boundingBox();
  assert.ok(rowBox.height <= 38, `Task row too tall: ${rowBox.height}`);
  const addProject = await page
    .getByRole("button", { name: "プロジェクトを追加", exact: true })
    .boundingBox();
  const caption = await page.locator(".sidebar-caption > span").boundingBox();
  assert.ok(
    Math.abs(
      addProject.y + addProject.height / 2 - caption.y - caption.height / 2,
    ) < 2,
  );
  const addTask = await voiceGroup.locator(".project-compose").boundingBox();
  const projectTitle = await voiceGroup
    .locator(".project-collapse > .collapse-heading > .collapse-toggle > span")
    .last()
    .boundingBox();
  assert.ok(
    Math.abs(
      addTask.y + addTask.height / 2 - projectTitle.y - projectTitle.height / 2,
    ) < 2,
  );
  assert.equal(
    await voiceGroup
      .getByRole("button")
      .filter({ hasText: "共有ルーティングを確認" })
      .count(),
    1,
  );
  assert.equal(
    await toolsGroup
      .getByRole("button")
      .filter({ hasText: "共有ルーティングを確認" })
      .count(),
    0,
  );
  assert.equal(
    await voiceGroup
      .getByRole("button")
      .filter({ hasText: "未割り当ての依頼" })
      .count(),
    1,
  );
  assert.equal(
    await page
      .locator('.project-list > section[aria-label="ほかのPC"]')
      .count(),
    0,
  );
  client.connected = false;
  await page.getByRole("button", { name: "最新の状態に更新" }).click();
  await page
    .getByText("ほかのPCの状態を見るには接続してください。", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator('.project-group[data-project-id="project"]')
      .getByRole("region", { name: "ほかのPC", exact: true })
      .locator(".task-link")
      .count(),
    0,
  );
  client.connected = true;
  await page.getByRole("button", { name: "最新の状態に更新" }).click();
  await page
    .locator(".task-link")
    .filter({ hasText: "Discordフォーラムの同期を整える" })
    .click();
  await page.getByRole("button", { name: "実行する", exact: true }).waitFor();
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.locator(".with-inspector").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-manual.png",
  });
  await page
    .getByLabel("エージェントへの追加指示")
    .fill("再起動時の重複も確認してください");
  await page
    .getByRole("button", { name: "追加指示を送信", exact: true })
    .click();
  await page
    .getByText("再起動時の重複も確認してください", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "実行する", exact: true }).waitFor();
  await page.getByRole("button", { name: "実行する", exact: true }).click();
  await page
    .getByText("1 件のファイルを変更", { exact: true })
    .first()
    .waitFor();
  await page
    .getByLabel("エージェントへの追加指示")
    .fill("公開せず、ローカルの検証までお願いします");
  await page
    .getByRole("button", { name: "追加指示を送信", exact: true })
    .click();
  await page
    .getByText("公開せず、ローカルの検証までお願いします", { exact: true })
    .waitFor();
  for (let attempt = 0; !steers.length && attempt < 100; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(steers, ["公開せず、ローカルの検証までお願いします"]);
  await page
    .locator(".tool-entry")
    .filter({ hasText: "コマンドを実行" })
    .last()
    .locator("summary")
    .click();
  await page
    .getByText(/Fixture output: 12 tests passed/)
    .last()
    .waitFor({ state: "visible" });
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-running.png",
  });
  await page
    .getByRole("button", { name: "変更を確認", exact: true })
    .first()
    .click();
  await page.getByRole("tabpanel", { name: "変更", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByText(/export const sync = true/).waitFor();
  assert.match(await page.locator(".diff-preview").innerText(), /sync = true/);
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-changes.png",
  });
  await inspector.getByRole("tab", { name: "環境", exact: true }).click();
  await page.getByLabel("タスクを検索").fill("Mac");
  await page
    .locator(".task-link")
    .filter({ hasText: "Macの接続手順を確認" })
    .click();
  await page
    .getByText("表示確認用の過去タスクです。", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "タスクを停止", exact: true })
      .count(),
    0,
  );
  assert.ok(await page.getByLabel("エージェントへの追加指示").isEnabled());
  assert.ok(
    await page
      .getByRole("button", { name: "追加指示を送信", exact: true })
      .isDisabled(),
  );
  await page.getByLabel("タスクを検索").fill("");
  await page
    .locator(".task-link")
    .filter({ hasText: "Discordフォーラムの同期を整える" })
    .click();
  await page.getByRole("button", { name: "タスクを停止", exact: true }).click();
  await page.getByText("停止済み", { exact: true }).waitFor();
  await page
    .locator(
      '.project-group[data-project-id="project"] .project-collapse > .collapse-heading',
    )
    .hover();
  await page
    .getByRole("button", { name: "discord-voiceの設定", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "このPCでタスクを開始", exact: true })
    .click();
  const localDialog = page.getByRole("dialog", {
    name: "このPCでタスクを開始",
    exact: true,
  });
  assert.equal(
    await localDialog
      .getByRole("checkbox", { name: "Discordにも共有", exact: true })
      .isChecked(),
    true,
  );
  assert.equal(
    await localDialog.getByLabel("共有先プロジェクト").inputValue(),
    "project",
  );
  await localDialog
    .getByRole("checkbox", { name: "Discordにも共有", exact: true })
    .uncheck();
  assert.equal(await localDialog.getByLabel("共有先プロジェクト").count(), 0);
  await localDialog
    .getByRole("checkbox", { name: "Discordにも共有", exact: true })
    .check();
  let localInput;
  await page.route("**/api/local-tasks/start", async (route) => {
    localInput = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runId: "run" }),
    });
  });
  await localDialog.getByLabel(/^タイトル/).fill("Local shared fixture");
  await localDialog
    .getByLabel("依頼内容", { exact: true })
    .fill("Test local sharing");
  await localDialog
    .getByRole("button", { name: "ローカルで開始", exact: true })
    .click();
  await localDialog.waitFor({ state: "hidden" });
  assert.equal(localInput.shareDiscord, true);
  assert.equal(localInput.shareProjectId, "project");
  assert.equal(localInput.accessMode, "full");
  await page.unroute("**/api/local-tasks/start");
  // Retain access-mode labels and place sharing notices inside the right panel.
  value.origin = "local";
  value.accessMode = "full";
  value.discordShare = {
    engineUrl: "https://fixture.example.invalid",
    deviceId: "fixture-device",
    projectId: "project",
    sequence: 1,
    status: "pending",
  };
  await page.getByRole("button", { name: "最新の状態に更新" }).click();
  await page
    .getByRole("button", { name: "フルアクセス・承認なし", exact: true })
    .waitFor();
  await inspector.getByText("Discord共有", { exact: true }).waitFor();
  await inspector
    .getByText(
      "Discordへの共有待ちです。同じチームへの接続後に再試行します。",
      { exact: true },
    )
    .waitFor();
  value.accessMode = "approval";
  value.discordShare.status = "synced";
  await page.getByRole("button", { name: "最新の状態に更新" }).click();
  await page
    .getByRole("button", { name: "許可を求める", exact: true })
    .waitFor();
  await inspector
    .getByText(
      "Discord共有用タスクをEngineに登録済みです。スレッド反映はBotの同期後に行われます。",
      { exact: true },
    )
    .waitFor();
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-sharing-inspector.png",
  });
  delete value.origin;
  delete value.accessMode;
  delete value.discordShare;

  // The project workspace replaces the old global local-task/run navigation.
  assert.equal(
    await page
      .getByRole("button", { name: "新しいローカルタスク", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "実行と承認", exact: true }).count(),
    0,
  );
  client.settings.profile = { name: "Demo user", context: "" };
  await page.getByRole("button", { name: "最新の状態に更新" }).click();
  await page.getByRole("button", { name: "ユーザー設定を開く" }).click();
  const avatarFile = await page.locator(".brand-symbol").screenshot();
  await page.locator('input[type="file"]').setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: avatarFile,
  });
  await page.locator(".profile-avatar-editor img").waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await page.locator(".local-avatar img").waitFor();
  assert.match(client.settings.profile.avatar, /^data:image\/jpeg;base64,/);
  await page.reload();
  await page.locator(".local-avatar img").waitFor();
  await page.locator(".task-avatars img").first().waitFor();
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-avatars.png",
  });
  await page.getByRole("button", { name: "ユーザー設定を開く" }).click();
  await page.getByRole("button", { name: "アイコンを削除" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(client.settings.profile.avatar, undefined);

  client.connected = false;
  await page.getByRole("button", { name: "最新の状態に更新" }).click();
  await page.locator(".connection-required").waitFor();
  for (const row of await page.locator(".task-link").all())
    assert.ok(await row.isDisabled());
  for (const button of await page.locator(".project-compose").all())
    assert.ok(await button.isDisabled());
  assert.equal(await page.getByLabel("エージェントへの追加指示").count(), 0);
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-disconnected.png",
  });
  let reconnects = 0;
  client.settings.engineUrl = "https://engine.example.invalid";
  client.connect = async () => {
    reconnects++;
    client.connected = true;
    client.status = "connected";
  };
  await page.getByRole("button", { name: "再接続", exact: true }).click();
  await page.locator(".connection-required").waitFor({ state: "hidden" });
  assert.equal(reconnects, 1);
  for (const row of await page.locator(".task-link").all())
    assert.ok(await row.isEnabled());
  client.projectCreationSupported = true;
  await page.getByRole("button", { name: "最新の状態に更新" }).click();
  await page
    .getByRole("button", { name: "プロジェクトを追加", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await page.waitForTimeout(250);
  const box = await dialog.boundingBox();
  assert.ok(
    Math.abs(box.y + box.height / 2 - 490) < 25,
    "Project modal must be vertically centered",
  );
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-project-modal.png",
  });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 430, height: 850 });
  await page
    .getByRole("button", { name: "サイドバーを閉じる", exact: true })
    .click();
  await page.getByRole("button", { name: "タスクの詳細", exact: true }).click();
  await page
    .getByRole("dialog", { name: "タスクの詳細", exact: true })
    .waitFor();
  await page.getByRole("tab", { name: "ソース", exact: true }).click();
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-mobile-panel.png",
  });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-mobile.png",
  });
  assert.ok(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Workspace smoke passed: light/dark/system appearance and localStorage persistence, compact unified task rows and unread result acknowledgements, right environment/sources/diff panels, actual branch and detached HEAD, profile context, mobile drawer, Manual discussion -> execute, live instruction, command output, diff, search, stop, offline gating, reconnect, avatar upload/removal, centered modal and narrow layout.",
  );
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page
      .screenshot({ path: ".ido-build/screenshots/workspace-failure.png" })
      .catch(() => {});
    console.error(
      await page
        .locator("main")
        .innerText()
        .catch(() => ""),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await client.close();
  await running;
  await rm(directory, { recursive: true, force: true });
}
