import { endpoint } from "@ido/common/contracts/protocol";
const downloads = [
  [
    "windowsDownloadUrl",
    "Windows",
    "インストーラーを開き、スタートメニューからIDO Agentを起動します。",
  ],
  [
    "macArmDownloadUrl",
    "Mac · Apple Silicon",
    "DMGを開き、IDO AgentをApplicationsへ移動して起動します。",
  ],
  [
    "macIntelDownloadUrl",
    "Mac · Intel",
    "DMGを開き、IDO AgentをApplicationsへ移動して起動します。",
  ],
] as const;
export function validateDownloads(config: Record<string, string>) {
  for (const [key] of downloads) {
    if (!config[key]) continue;
    const url = new URL(config[key]);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("DOWNLOAD_HTTPS_REQUIRED");
  }
  if (
    config.issueForumChannelId &&
    !/^\d{17,20}$/.test(config.issueForumChannelId)
  )
    throw new Error("ISSUE_FORUM_ID_INVALID");
}
export function connectionLink(origin: string) {
  return new URL("/plugins/discord/connect", endpoint(origin)).href;
}
function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
export function connectionPage(origin: string, config: Record<string, string>) {
  validateDownloads(config);
  const engine = endpoint(origin).origin;
  const launch = `ido-agent://connect?engine=${encodeURIComponent(engine)}`;
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>IDO Agent · PCを接続</title><body><main>
  <h1>IDO Agentで、あなたのPCを接続</h1><p>作業フォルダーと権限を自分で確認し、Discordから依頼されたタスクを実行できます。</p>
  <h2>1. アプリをインストール</h2><ul>${downloads.map(([key, name, help]) => `<li><h3>${name}</h3>${config[key] ? `<a href="${escape(config[key])}" rel="noreferrer">${name}版をダウンロード</a>` : `<p>配布準備中です。管理者にこのOSのダウンロードURLの設定を依頼してください。</p>`}<p>${help}</p></li>`).join("")}</ul>
  <h2>2. 接続先をアプリに入力</h2><p><a href="${escape(launch)}">IDO Agentを開いて接続先を入力</a></p><p>起動しない場合はインストール後にアプリを開き、次のURLを「EngineのURL」に貼り付けてください。</p><pre>${escape(engine)}</pre>
  <h2>3. チームとエージェントにログイン</h2><ol><li>アプリの「接続とセットアップ」から「接続の確認へ」を押し、ブラウザーでEngineへログインして端末の確認値を照合・承認します。Engineの参加アカウントは管理者が用意します。</li><li>実行に使うCodexまたはClaudeの公式ログインを開き、自分のアカウントでログインします。チームへのログインとは別です。</li></ol>
  <h2>4. プロジェクトへ参加して実行を許可</h2><ol><li>参加者からプロジェクトの招待URLを受け取って開きます。自分で作る場合はアプリの「プロジェクトを追加」を使います。</li><li>プロジェクトメニューの「接続・設定」で作業フォルダーと通信・同時実行数・権限を確認し、「タスクの実行許可」を有効にします。</li><li>「新しいタスク」はチームへの依頼、「このPCでタスクを開始」は自分のPCでの実行です。Issueが不要な質問や申し送りは「相談・共有」に投稿します。</li></ol>
  <p>このリンクだけではログイン・接続・タスク実行は始まりません。認証情報は各自のPCで管理します。アプリを終了すると、そのアプリの実行も停止します。</p><p>Gitが未導入の場合: <a href="https://git-scm.com/downloads" rel="noreferrer">Gitの公式ダウンロード</a>。Macで起動が拒否される配布物は管理者に署名済み版を依頼してください。</p>
  </main></body></html>`;
}
