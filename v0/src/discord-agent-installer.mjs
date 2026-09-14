import { readFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname } from "node:path";

// Publish exactly one explicitly configured installer, never a directory.
export async function agentInstallerHandler(path) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    extname(path).toLowerCase() !== ".exe" ||
    info.size < 2 ||
    info.size > 350 * 1024 * 1024
  )
    throw new Error("Expected a regular Windows installer (max 350 MiB)");
  const bytes = await readFile(path);
  if (bytes.length !== info.size)
    throw new Error("Installer changed while reading");
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a)
    throw new Error("Installer is not a Windows executable");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const page = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>IDO Agentをインストール</title><style>body{font:16px system-ui;background:#111318;color:#edf0f4;max-width:760px;margin:60px auto;padding:24px;line-height:1.9}a{display:inline-block;background:#b3efcf;color:#153329;padding:14px 24px;border-radius:10px}code{overflow-wrap:anywhere}li{margin:16px 0}</style><h1>IDO Agentをインストール</h1><p>自分のPCでエージェントを動かし、Discordからタスクを受け取ります。</p><a href="/agent/installer.exe" download>Windows用インストーラーをダウンロード（${Math.ceil(bytes.length / 1024 / 1024)} MB）</a><p>テスト用配布です。未署名の場合はWindowsに発行者の確認が表示されます。配布元を確認してください。</p><ol><li>ダウンロードした <strong>IDO-Agent-Setup.exe</strong> を開き、インストールします。</li><li>Windowsのスタートメニューで <strong>IDO Agent</strong> を検索して起動します。インストール後は自動起動しません。</li><li>接続設定からOpenAIにログインします。Gitと作業するリポジトリを自分のPCに用意します。</li><li>Discordで <code>/ido agent connect</code> を選び、参加情報をアプリに貼り付けます。</li><li>作業フォルダーと接続先を確認して接続します。操作の許可はアプリ内で確認できます。</li></ol><p>終了すると、このアプリの接続と実行を停止します。ログイン情報をBotに渡す必要はありません。</p><p>SHA-256: <code>${hash}</code></p></html>`;
  let active = 0;
  return (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405);
      return response.end();
    }
    if (request.url === "/agent") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return response.end(request.method === "HEAD" ? undefined : page);
    }
    if (request.url !== "/agent/installer.exe") {
      response.writeHead(404);
      return response.end();
    }
    if (active >= 4) {
      response.writeHead(503);
      return response.end();
    }
    active++;
    response.once("close", () => active--);
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": bytes.length,
      "Content-Disposition": 'attachment; filename="IDO-Agent-Setup.exe"',
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  };
}
