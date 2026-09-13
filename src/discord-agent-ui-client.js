/* global document, location, history */
const token =
  location.hash.slice(1) || sessionStorage.getItem("agent-ui-token");
if (token) sessionStorage.setItem("agent-ui-token", token);
history.replaceState(null, "", "/");
const element = (id) => document.getElementById(id);
let initialized = false;
let submitting = false;
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
    if (!initialized) {
      element("workdir").value = state.profile.workingDirectory ?? "";
      element("gateway").value = state.profile.gatewayUrl ?? "";
      element("name").value = state.profile.name ?? "";
      initialized = true;
    }
    element("auth-status").textContent = state.login.pending
      ? "OpenAIの認証ページでログインを完了してください。"
      : state.login.authenticated
        ? "ログイン済み。このPCのCodex認証を使います。"
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
    for (const id of ["workdir", "gateway", "code", "name", "folder"])
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
  };
  element("code").value = "";
  try {
    await request("/connect", input);
  } finally {
    submitting = false;
    input.pairingCode = "";
  }
});
action("stop", () => request("/stop", {}));
void update();
setInterval(update, 2000);
