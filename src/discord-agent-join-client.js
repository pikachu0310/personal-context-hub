/* global document, location, history, addEventListener */
// The invitation stays in this page's memory, never query strings or storage.
// This page has no local control capability and cannot call authenticated APIs.
let invitation = location.hash.slice(1);
history.replaceState(null, "", "/join");
const status = document.getElementById("status");
const retry = document.getElementById("retry");
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
      "入力しました。元の接続画面に戻って、接続先と作業フォルダーを確認してください。このタブは閉じてかまいません。";
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
      "接続画面が見つかりません。同じPCで Start Agent.cmd から開いた接続画面を残し、このリンクも同じブラウザ・同じプロファイルで開いてください。難しい場合はDiscordの参加情報を手動で貼り付けられます。";
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
