/* global document, window */
const api = window.idoDesktop;
const el = (id) => document.getElementById(id);
let state,
  selected,
  filter = "all",
  initialized = false,
  busy = false,
  taskSignature;
const active = (task) =>
  ["running", "awaiting_approval", "pausing", "paused"].includes(task.state);
const labels = {
  running: "実行中",
  awaiting_approval: "承認待ち",
  completed: "完了",
  cancelled: "停止済み",
  failed: "失敗",
  not_started: "実行しませんでした",
  external: "外部で管理 · 状態未確認",
  pausing: "一時停止中…",
  paused: "一時停止済み",
};
const time = (value) =>
  new Date(value).toLocaleString("ja-JP", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
function view(settings) {
  el("settings-view").hidden = !settings;
  el("tasks-view").hidden = settings;
  el("page-title").textContent = settings ? "接続設定" : "タスク";
  el("view-settings").classList.toggle("active", settings);
  el("view-tasks").classList.toggle("active", !settings);
}
function renderTasks() {
  const tasks = state?.tasks ?? [];
  el("task-count").textContent = tasks.length;
  const query = el("search").value.toLowerCase();
  const visible = tasks.filter(
    (task) =>
      (!query || task.title.toLowerCase().includes(query)) &&
      (filter === "all" ||
        (filter === "active"
          ? active(task)
          : !active(task) && task.state !== "external")),
  );
  const task = visible.find((item) => item.id === selected) ?? visible[0];
  selected = task?.id;
  el("task-list").replaceChildren();
  for (const task of visible) {
    const row = document.createElement("button");
    row.className = "task-row" + (task.id === selected ? " selected" : "");
    const title = document.createElement("strong");
    title.textContent = task.title;
    const subtitle = document.createElement("small");
    subtitle.textContent = `${labels[task.state] ?? task.state} · ${time(task.startedAt)}`;
    row.append(title, subtitle);
    row.onclick = () => {
      selected = task.id;
      view(false);
      renderTasks();
    };
    el("task-list").append(row);
  }
  el("empty").hidden = Boolean(task);
  el("work-area").hidden = !task;
  if (!task) return;
  el("task-title").textContent = task.title;
  el("task-request").textContent = task.request;
  el("task-state").textContent = labels[task.state] ?? task.state;
  el("task-source").textContent =
    task.source === "discord"
      ? "Discord · 自分のエージェント"
      : "Codex App / CLI · 参照のみ";
  el("task-workdir").textContent = task.workingDirectory || "—";
  el("task-started").textContent = time(task.startedAt);
  el("task-updated").textContent = time(
    task.updatedAt ?? task.finishedAt ?? task.logs.at(-1)?.at ?? task.startedAt,
  );
  el("cancel-task").disabled = !active(task);
  el("pause-task").disabled = task.state !== "running";
  el("task-permissions").textContent = task.automaticPermissions
    ? "全承認：サンドボックス外への追加権限も自動承認"
    : "追加権限は操作ごとに確認";
  el("resume-controls").hidden = task.state !== "paused";
  el("retry-help").hidden = active(task) || task.source !== "discord";
  el("retry-help").textContent =
    `終了したタスクをやり直す場合はDiscordで /ido follow ${task.id} 前回の続きから再実行してください を送ります。`;
  const command = (state.commandApprovals ?? []).find(
    (item) => item.taskId === task.id,
  );
  el("command-approval").hidden = !command;
  el("command-preview").textContent = command
    ? `${command.operation}\n\n作業場所: ${command.cwd || "—"}\n理由: ${command.reason || "—"}`
    : "";
  if (command) el("task-state").textContent = "操作の承認待ち";
  el("approval").hidden = !state.approvals.some(
    (item) => item.taskId === task.id,
  );
  el("logs").replaceChildren();
  for (const log of task.logs) {
    if (task.result && log.text === task.result.slice(0, 2000)) continue;
    const entry = document.createElement("div");
    entry.className = "log-entry";
    const at = document.createElement("time");
    at.textContent = time(log.at);
    const text = document.createElement("pre");
    text.textContent = log.text;
    entry.append(at, text);
    el("logs").append(entry);
  }
  if (!task.logs.length)
    el("logs").textContent = active(task)
      ? "タスクの進捗を待っています。"
      : "このタスクの進捗ログはありません。";
  el("result").textContent = task.errorMessage ?? task.result ?? "";
}
async function refresh() {
  try {
    state = await api.request("/status");
    el("process-info").textContent = state.processInfo
      ? `タスクマネージャーの「詳細」で ${state.processInfo.name} / PID ${state.processInfo.pid} を確認できます。バージョン ${state.processInfo.version}`
      : "";
    el("local-tasks").checked = state.localTasks?.enabled ?? false;
    el("local-task-status").textContent = !state.localTasks?.enabled
      ? "表示を有効にすると、このPCのCodexの直近タスク名と作業場所を読み取ります。Discordには送りません。"
      : state.localTasks.available
        ? "参照表示中。実行状態の取得・停止操作は元のCodexで行ってください。"
        : "対応するCodexのローカル履歴が見つかりません。WSL・別のPCの履歴は対象外です。";
    if (!initialized) {
      for (const [id, key] of [
        ["workdir", "workingDirectory"],
        ["gateway", "gatewayUrl"],
        ["name", "name"],
      ])
        el(id).value = state.profile[key] ?? "";
      initialized = true;
    }
    el("connection-dot").classList.toggle("online", state.connected);
    el("connection-status").textContent = state.busy
      ? "接続しています…"
      : state.connected
        ? "接続中"
        : state.revoked
          ? "登録が失効しました"
          : state.reconnecting
            ? "再接続中"
            : "未接続";
    el("auth-status").textContent = state.login.pending
      ? "ブラウザでログインを完了してください。"
      : state.login.authenticated
        ? "ログイン済み · 認証情報はこのPC内で管理します。"
        : "未ログインです。OpenAIの公式ページでログインしてください。";
    el("login-link").hidden = !state.login.loginUrl;
    const connected = state.connected || state.reconnecting || state.revoked;
    el("permission-status").textContent = state.connectionPolicy
      ?.automaticPermissions
      ? "全承認モード · 追加権限も自動承認中"
      : "追加権限は個別承認 · このPCで実行";
    el("setup-sandbox").hidden = !state.sandboxSetup?.supported;
    el("setup-sandbox").disabled =
      busy || connected || state.busy || state.sandboxSetup?.pending;
    el("sandbox-status").textContent = state.sandboxSetup?.pending
      ? "サンドボックスを準備しています。Windowsの確認画面を確認してください。"
      : (state.sandboxSetup?.error ??
        (state.sandboxSetup?.ready
          ? "サンドボックスの準備が完了しました。"
          : "Windowsで読み取り専用になってしまう場合は、初回セットアップを行ってください。"));
    el("login").disabled =
      busy || connected || state.busy || state.login.pending;
    el("connect").disabled =
      busy || connected || state.busy || !state.login.authenticated;
    el("disconnect").disabled = state.busy || !connected;
    for (const id of [
      "invitation",
      "import",
      "gateway",
      "name",
      "workdir",
      "folder",
      "automatic",
      "network",
      "automatic-permissions",
    ])
      el(id).disabled = busy || state.busy || connected;
    if (state.connectionPolicy) {
      el("automatic").checked = state.connectionPolicy.automatic;
      el("network").checked = state.connectionPolicy.networkAccess;
      el("automatic-permissions").checked =
        state.connectionPolicy.automaticPermissions === true;
    }
    const signature = JSON.stringify([
      state.tasks,
      state.approvals,
      state.commandApprovals,
    ]);
    if (signature !== taskSignature) {
      taskSignature = signature;
      renderTasks();
    }
  } catch {
    el("error").textContent =
      "状態を取得できません。アプリを再起動してください。";
  }
}
function action(id, run) {
  el(id).onclick = async () => {
    if (busy) return;
    busy = true;
    el("error").textContent = "";
    try {
      await run();
    } catch (error) {
      el("error").textContent = String(error.message).replace(
        /^Error invoking remote method '[^']+': Error: /,
        "",
      );
    } finally {
      busy = false;
      await refresh();
    }
  };
}
for (const id of ["view-settings", "setup-shortcut", "empty-setup"])
  el(id).onclick = () => view(true);
el("view-tasks").onclick = () => view(false);
for (const key of ["all", "active", "done"])
  el(`filter-${key}`).onclick = () => {
    filter = key;
    for (const value of ["all", "active", "done"])
      el(`filter-${value}`).classList.toggle("active", value === key);
    renderTasks();
  };
el("search").oninput = renderTasks;
action("local-tasks", () =>
  api.request("/local-tasks", { enabled: el("local-tasks").checked }),
);
action("login", () => api.request("/login", {}));
action("refresh", () => api.request("/refresh-login", {}));
action("login-link", () => api.openExternal(state.login.loginUrl));
action("git-help", () => api.openExternal("https://git-scm.com/downloads/win"));
action("import", async () => {
  const invitation = el("invitation").value.trim();
  el("invitation").value = "";
  const data = await api.request("/invitation", { invitation });
  el("gateway").value = data.gatewayUrl;
  el("code").value = data.pairingCode;
  el("automatic").checked = false;
  el("network").checked = false;
  el("automatic-permissions").checked = false;
});
action("folder", async () => {
  const result = await api.request("/folder", {});
  if (result.path) el("workdir").value = result.path;
});
action("setup-sandbox", () =>
  api.request("/setup-sandbox", { workingDirectory: el("workdir").value }),
);
action("connect", async () => {
  const input = {
    gatewayUrl: el("gateway").value,
    pairingCode: el("code").value,
    workingDirectory: el("workdir").value,
    name: el("name").value,
    automatic: el("automatic").checked,
    automaticPermissions: el("automatic-permissions").checked,
    networkAccess: el("network").checked,
  };
  el("code").value = "";
  await api.request("/connect", input);
  view(false);
});
action("disconnect", async () => {
  await api.request("/stop", {});
  el("automatic").checked = false;
  el("network").checked = false;
  el("automatic-permissions").checked = false;
});
action("cancel-task", () => api.request("/stop-task", { id: selected }));
action("pause-task", async () => {
  el("resume-network").checked = false;
  el("resume-permissions").checked = false;
  await api.request("/pause-task", { id: selected });
});
action("resume-task", () =>
  api.request("/resume-task", {
    id: selected,
    networkAccess: el("resume-network").checked,
    automaticPermissions: el("resume-permissions").checked,
  }),
);
for (const approved of [true, false])
  action(approved ? "allow-command" : "deny-command", () => {
    const command = (state.commandApprovals ?? []).find(
      (item) => item.taskId === selected,
    );
    if (command)
      return api.request("/approve-command", { id: command.id, approved });
  });
for (const approved of [true, false])
  action(approved ? "approve" : "reject", async () => {
    const item = state.approvals.find((item) => item.taskId === selected);
    if (item) await api.request("/approve", { id: item.id, approved });
  });
el("quit").onclick = () => api.quit();
void refresh();
setInterval(refresh, 1500);
