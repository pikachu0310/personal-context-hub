/* global document, location, history */
const token =
  location.hash.slice(1) || sessionStorage.getItem("agent-ui-token");
if (token) sessionStorage.setItem("agent-ui-token", token);
history.replaceState(null, "", "/");
const element = (id) => document.getElementById(id);
let initialized = false;
let submitting = false;
let renderedApprovals = "";
function showApprovals(approvals) {
  const signature = JSON.stringify(approvals);
  if (signature === renderedApprovals) return;
  renderedApprovals = signature;
  element("approval-section").hidden = approvals.length === 0;
  element("approvals").replaceChildren();
  for (const item of approvals) {
    const article = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = item.title;
    const details = document.createElement("pre");
    details.textContent = [
      item.request,
      item.context,
      item.additionalInstruction,
    ]
      .filter(Boolean)
      .join("\n\n");
    article.append(title, details);
    for (const approved of [true, false]) {
      const button = document.createElement("button");
      button.textContent = approved ? "このタスクを実行" : "実行しない";
      button.className = approved ? "" : "secondary";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await request("/approve", { id: item.id, approved });
        } catch (error) {
          element("error").textContent = error.message;
        }
        await update();
      });
      article.append(button);
    }
    element("approvals").append(article);
  }
}
async function request(path, input) {
  const response = await fetch(path, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(input === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
async function update() {
  try {
    const state = await request("/status");
    showApprovals(state.approvals ?? []);
    if (state.connectionPolicy) {
      element("automatic").checked = state.connectionPolicy.automatic;
      element("network").checked = state.connectionPolicy.networkAccess;
    }
    if (!initialized) {
      element("workdir").value = state.profile.workingDirectory ?? "";
      element("gateway").value = state.profile.gatewayUrl ?? "";
      element("name").value = state.profile.name ?? "";
      initialized = true;
    }
    element("auth-status").textContent = state.login.pending
      ? "OpenAIの認証ページでログインを完了してください。"
      : state.login.authenticated
        ? "ログイン済み。このPCの接続用Codex認証を使います。"
        : "未ログインです。OpenAIの公式ページでログインしてください。";
    element("login").disabled =
      state.login.pending ||
      state.busy ||
      state.connected ||
      state.reconnecting ||
      state.revoked;
    element("login-fallback").hidden = !state.login.loginUrl;
    if (state.login.loginUrl) element("login-link").href = state.login.loginUrl;
    element("folder").hidden = !state.canPickFolder;
    element("connection-status").textContent = state.busy
      ? "接続しています…"
      : state.revoked
        ? "登録が失効または置き換えられました。停止して新しい参加コードで接続してください。"
        : state.connected
          ? "接続中 · Discordからのタスクを受け取れます"
          : state.reconnecting
            ? "接続が切れました。再接続を待っています…"
            : "未接続";
    element("connect").disabled =
      submitting ||
      state.busy ||
      state.connected ||
      state.reconnecting ||
      state.revoked ||
      !state.login.authenticated;
    element("stop").disabled =
      state.busy || !(state.connected || state.reconnecting || state.revoked);
    for (const id of [
      "workdir",
      "gateway",
      "code",
      "name",
      "folder",
      "automatic",
      "network",
      "invitation",
      "import",
    ])
      element(id).disabled =
        submitting ||
        state.busy ||
        state.connected ||
        state.reconnecting ||
        state.revoked;
  } catch {
    element("error").textContent =
      "接続アプリにアクセスできません。起動ファイルから画面を開き直してください。";
  }
}
function action(id, run) {
  element(id).addEventListener("click", async () => {
    element("error").textContent = "";
    try {
      await run();
    } catch (error) {
      element("error").textContent = error.message;
    }
    await update();
  });
}
action("login", () => request("/login", {}));
action("refresh", () => request("/refresh-login", {}));
action("import", async () => {
  const invitation = element("invitation").value.trim();
  element("invitation").value = "";
  const result = await request("/invitation", { invitation });
  element("gateway").value = result.gatewayUrl;
  element("code").value = result.pairingCode;
});
action("folder", async () => {
  const result = await request("/folder", {});
  if (result.path) element("workdir").value = result.path;
});
action("connect", async () => {
  submitting = true;
  element("connect").disabled = true;
  const input = {
    workingDirectory: element("workdir").value,
    gatewayUrl: element("gateway").value,
    pairingCode: element("code").value,
    name: element("name").value,
    automatic: element("automatic").checked,
    networkAccess: element("network").checked,
  };
  element("code").value = "";
  try {
    await request("/connect", input);
  } finally {
    submitting = false;
    input.pairingCode = "";
  }
});
action("stop", async () => {
  await request("/stop", {});
  element("automatic").checked = false;
  element("network").checked = false;
});
void update();
setInterval(update, 2000);
