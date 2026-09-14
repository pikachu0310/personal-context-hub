import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { workerEnvironment } from "@ido/common/runtime/platform";
import type { Client } from "../bootstrap/client.js";

export function claudeBinary() {
  const require = createRequire(import.meta.url);
  return join(
    dirname(
      require.resolve(
        `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
      ),
    ),
    process.platform === "win32" ? "claude.exe" : "claude",
  );
}
export async function checkClaudeLogin(client: Client) {
  try {
    const { stdout } = await promisify(execFile)(
      claudeBinary(),
      ["auth", "status", "--json"],
      {
        cwd: client.directory,
        env: workerEnvironment(client.executor.home),
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 32768,
      },
    );
    const result = JSON.parse(stdout);
    client.claudeLoginStatus =
      result.loggedIn === true ? "authenticated" : "not authenticated";
  } catch {
    client.claudeLoginStatus =
      "認証を確認できません。公式ログインを完了してください。";
  }
}
export function officialClaudeLoginUrl(output: string) {
  for (const match of stripVTControlCharacters(output).matchAll(
    /https:\/\/[^\s<>"']+(?=\s)/g,
  )) {
    try {
      const url = new URL(match[0]);
      if (
        [
          "https://claude.ai",
          "https://platform.claude.com",
          "https://console.anthropic.com",
        ].includes(url.origin) &&
        url.pathname === "/oauth/authorize" &&
        !url.username &&
        !url.password
      )
        return url.href;
    } catch {
      /* Only complete official authorization links are displayed. */
    }
  }
}
export function startClaudeLogin(client: Client) {
  if (client.login) throw new Error("LOGIN_ALREADY_RUNNING");
  if (client.executor.active.size) throw new Error("STOP_TASKS_FIRST");
  const child = spawn(claudeBinary(), ["auth", "login"], {
    cwd: client.directory,
    env: workerEnvironment(client.executor.home),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  client.login = child;
  client.claudeLoginStatus =
    "ブラウザーでClaudeの公式ログインを完了してください。";
  client.claudeLoginUrl = undefined;
  let output = "";
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-32768);
    client.claudeLoginUrl =
      officialClaudeLoginUrl(output) ?? client.claudeLoginUrl;
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const timeout = setTimeout(() => child.kill(), 10 * 60_000);
  const finish = (code: number | null) => {
    clearTimeout(timeout);
    output = "";
    client.claudeLoginUrl = undefined;
    client.claudeLoginStatus =
      code === 0
        ? "authenticated"
        : "ログイン未完了。公式Claude Codeで認証してから再確認してください。";
    if (client.login === child) client.login = undefined;
  };
  child.once("error", () => finish(1));
  child.once("close", finish);
}
