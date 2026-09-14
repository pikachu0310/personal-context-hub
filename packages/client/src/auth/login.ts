import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { workerEnvironment } from "@ido/common/runtime/platform";
import type { Client } from "../bootstrap/client.js";
import { codexBinary } from "../execution/executor.js";

export function officialLoginUrl(output: string) {
  for (const match of stripVTControlCharacters(output).matchAll(
    /https:\/\/[^\s<>"']+(?=\s)/g,
  )) {
    try {
      const url = new URL(match[0]);
      if (
        url.origin === "https://auth.openai.com" &&
        !url.username &&
        !url.password &&
        url.pathname === "/oauth/authorize"
      )
        return url.href;
    } catch {
      /* Wait for a complete output chunk. */
    }
  }
}
export function startLogin(client: Client) {
  if (client.login) throw new Error("LOGIN_ALREADY_RUNNING");
  if (client.executor.active.size) throw new Error("STOP_TASKS_FIRST");
  client.loginStatus = "ブラウザーでOpenAIの公式ログインを完了してください。";
  client.loginUrl = undefined;
  const child = spawn(codexBinary(), ["login"], {
    env: workerEnvironment(client.executor.home),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  client.login = child;
  let output = "";
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-32768);
    client.loginUrl = officialLoginUrl(output) ?? client.loginUrl;
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const timeout = setTimeout(() => child.kill(), 10 * 60_000);
  const finish = (code: number | null) => {
    clearTimeout(timeout);
    output = "";
    client.loginUrl = undefined;
    client.loginStatus = code === 0 ? "authenticated" : "login failed";
    if (client.login === child) client.login = undefined;
    client.ready();
  };
  child.once("error", () => finish(1));
  child.once("close", finish);
}
