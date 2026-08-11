import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const TRAQ_ORIGIN = process.env.TRAQ_ORIGIN ?? "https://q.trap.jp";
export const TRAQ_API_BASE = new URL("/api/v3/", TRAQ_ORIGIN);
export const TRAQ_REDIRECT_URI = "http://127.0.0.1:8943/oauth/callback";
export const TRAQ_CALLBACK_PORT = 8943;
export const TRAQ_OAUTH_SCOPES = [
  "openid",
  "profile",
  "read",
  "write",
  "manage_bot",
];

const isWsl =
  process.platform === "linux" &&
  (Boolean(process.env.WSL_DISTRO_NAME) ||
    existsSync(
      "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ));
const dpapiScriptPath = fileURLToPath(
  new URL("../scripts/traq-token-dpapi.ps1", import.meta.url),
);
const dpapiScript = readFileSync(dpapiScriptPath, "utf8");

export function getTokenBackend() {
  if (process.env.PERSONAL_CONTEXT_TOKEN_PATH) return "file";
  if (process.env.PERSONAL_CONTEXT_TOKEN_BACKEND) {
    return process.env.PERSONAL_CONTEXT_TOKEN_BACKEND;
  }
  return process.platform === "win32" || isWsl ? "dpapi" : "file";
}

export function getTokenPath() {
  if (process.env.PERSONAL_CONTEXT_TOKEN_PATH) {
    return process.env.PERSONAL_CONTEXT_TOKEN_PATH;
  }

  const dataRoot =
    process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(dataRoot, "personal-context-hub", "traq-oauth.json");
}

export function getTokenStoreDescription() {
  return getTokenBackend() === "dpapi"
    ? "Windows DPAPI CurrentUser: %LOCALAPPDATA%\\personal-context-hub\\traq-oauth.dpapi"
    : getTokenPath();
}

function runDpapi(action, input = "") {
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
          `Windows DPAPI token operation failed (${code})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
    child.stdin.end(input);
  });
}

export async function readTokenStore(path) {
  let contents;
  try {
    contents =
      path || getTokenBackend() === "file"
        ? await readFile(path ?? getTokenPath(), "utf8")
        : await runDpapi("read");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "traQ is not authenticated. Run: npm run auth:traq -- --client-id <CLIENT_ID>",
      );
    }
    throw error;
  }

  const token = JSON.parse(contents);
  if (!token.clientId || !token.accessToken || !token.expiresAt) {
    throw new Error(
      `Invalid traQ token store at ${getTokenStoreDescription()}`,
    );
  }
  return token;
}

export async function writeTokenStore(token, path) {
  const contents = `${JSON.stringify(token, null, 2)}\n`;
  if (!path && getTokenBackend() === "dpapi") {
    await runDpapi("write", contents);
    return;
  }

  const resolvedPath = path ?? getTokenPath();
  await mkdir(dirname(resolvedPath), { recursive: true });
  const temporaryPath = `${resolvedPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, contents, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, resolvedPath);
  await chmod(resolvedPath, 0o600).catch(() => undefined);
}
