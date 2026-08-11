import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DISCORD_API_BASE = new URL("https://discord.com/api/v10/");

const isWsl =
  process.platform === "linux" &&
  (Boolean(process.env.WSL_DISTRO_NAME) ||
    existsSync(
      "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ));
const dpapiScriptPath = fileURLToPath(
  new URL("../scripts/discord-token-dpapi.ps1", import.meta.url),
);
const dpapiScript = readFileSync(dpapiScriptPath, "utf8");

export function getDiscordTokenBackend() {
  if (process.env.PERSONAL_CONTEXT_DISCORD_TOKEN_PATH) return "file";
  if (process.env.PERSONAL_CONTEXT_DISCORD_TOKEN_BACKEND) {
    return process.env.PERSONAL_CONTEXT_DISCORD_TOKEN_BACKEND;
  }
  return process.platform === "win32" || isWsl ? "dpapi" : "file";
}

export function getDiscordTokenPath() {
  if (process.env.PERSONAL_CONTEXT_DISCORD_TOKEN_PATH) {
    return process.env.PERSONAL_CONTEXT_DISCORD_TOKEN_PATH;
  }
  const dataRoot =
    process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(dataRoot, "personal-context-hub", "discord-bot.json");
}

export function getDiscordTokenStoreDescription() {
  return getDiscordTokenBackend() === "dpapi"
    ? "Windows DPAPI CurrentUser: %LOCALAPPDATA%\\personal-context-hub\\discord-bot.dpapi"
    : getDiscordTokenPath();
}

function runDiscordDpapi(action, input = "") {
  return new Promise((resolve, reject) => {
    const powershellExecutable = isWsl
      ? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
      : "powershell.exe";
    const child = spawn(
      powershellExecutable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(
          `$env:PERSONAL_CONTEXT_DPAPI_ACTION = '${action}';\n${dpapiScript}`,
          "utf16le",
        ).toString("base64"),
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(
        new Error(
          `Windows DPAPI Discord credential operation failed (${code})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
    child.stdin.end(input);
  });
}

export async function readDiscordTokenStore(path) {
  let contents;
  try {
    contents =
      path || getDiscordTokenBackend() === "file"
        ? await readFile(path ?? getDiscordTokenPath(), "utf8")
        : await runDiscordDpapi("read");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "Discord is not authenticated. Store a Bot token with: npm run auth:discord -- --application-id <APPLICATION_ID>",
      );
    }
    throw error;
  }

  const credential = JSON.parse(contents);
  if (!credential.token || !credential.applicationId || !credential.botUserId) {
    throw new Error(
      `Invalid Discord credential store at ${getDiscordTokenStoreDescription()}`,
    );
  }
  return credential;
}

export async function writeDiscordTokenStore(credential, path) {
  const contents = `${JSON.stringify(credential, null, 2)}\n`;
  if (!path && getDiscordTokenBackend() === "dpapi") {
    await runDiscordDpapi("write", contents);
    return;
  }

  const resolvedPath = path ?? getDiscordTokenPath();
  await mkdir(dirname(resolvedPath), { recursive: true });
  const temporaryPath = `${resolvedPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, contents, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, resolvedPath);
  await chmod(resolvedPath, 0o600).catch(() => undefined);
}
