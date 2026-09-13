/* global document, location, history, addEventListener, window */
// The invitation stays in this page's memory, never query strings or storage.
// This page has no local control capability and cannot call authenticated APIs.
let invitation = location.hash.slice(1);
history.replaceState(null, "", "/join");
const status = document.getElementById("status");
const retry = document.getElementById("retry");
document.getElementById("show-control").addEventListener("click", () => {
  window.open("", "ido-agent-control")?.focus();
});
const channel = new BroadcastChannel("ido-agent-invitation");
let requestId;
let timer;
channel.onmessage = ({ data }) => {
  if (!requestId || data?.type !== "invitation-result" || data.id !== requestId)
    return;
  clearTimeout(timer);
  requestId = undefined;
  if (data.ok === true) {
    invitation = "";
    retry.hidden = true;
    status.textContent =
      "入力しました。下の「接続画面を表示」を押し、接続先と作業フォルダーを確認してください。切り替わらない場合はブラウザのタブ一覧から「井戸Bot · エージェント接続」を選んでください。";
  } else {
    status.textContent =
      "入力できませんでした。接続画面で接続・操作中なら完了後に停止してください。参加情報が期限切れの場合はDiscordで再発行してください。";
    retry.disabled = false;
    retry.hidden = false;
  }
};
function send() {
  if (invitation.length > 4096 || !/^ido1\.[A-Za-z0-9_-]+$/.test(invitation)) {
    invitation = "";
    status.textContent =
      "参加リンクが無効です。Discordで /ido agent connect を選び、新しいリンクを開いてください。";
    retry.hidden = true;
    return;
  }
  requestId = crypto.randomUUID();
  retry.hidden = true;
  status.textContent = "接続画面に参加情報を入力しています…";
  channel.postMessage({ type: "invitation", id: requestId, invitation });
  timer = setTimeout(() => {
    requestId = undefined;
    status.textContent =
      "接続画面が見つかりません。Discordの /ido agent setup で Connect-Agent.cmd をダウンロードして同じPCで開き、接続画面を残してください。このリンクも同じブラウザ・同じプロファイルで開きます。参加情報の手動貼り付けも使えます。";
    retry.hidden = false;
    retry.disabled = false;
  }, 5000);
}
retry.addEventListener("click", send);
// Browsers may reuse the landing tab for another Discord link. A fragment-only
// navigation does not reload the page, so import the new invitation explicitly.
addEventListener("hashchange", () => {
  clearTimeout(timer);
  invitation = location.hash.slice(1);
  history.replaceState(null, "", "/join");
  send();
});
send();
