import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DISCORD_RPC_SCOPES = ["rpc", "identify", "messages.read"];
export const DISCORD_RPC_REDIRECT_URI = "http://localhost";
export const DISCORD_OAUTH_TOKEN_URL =
  "https://discord.com/api/v10/oauth2/token";

const isWsl =
  process.platform === "linux" &&
  (Boolean(process.env.WSL_DISTRO_NAME) ||
    existsSync(
      "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ));
const dpapiScriptPath = fileURLToPath(
  new URL("../scripts/discord-rpc-credential-dpapi.ps1", import.meta.url),
);
const dpapiScript = readFileSync(dpapiScriptPath, "utf8");

export function getDiscordRpcCredentialBackend() {
  if (process.env.PERSONAL_CONTEXT_DISCORD_RPC_PATH) return "file";
  if (process.env.PERSONAL_CONTEXT_DISCORD_RPC_BACKEND) {
    return process.env.PERSONAL_CONTEXT_DISCORD_RPC_BACKEND;
  }
  return process.platform === "win32" || isWsl ? "dpapi" : "file";
}

export function getDiscordRpcCredentialPath() {
  if (process.env.PERSONAL_CONTEXT_DISCORD_RPC_PATH) {
    return process.env.PERSONAL_CONTEXT_DISCORD_RPC_PATH;
  }
  const dataRoot =
    process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(dataRoot, "personal-context-hub", "discord-rpc.json");
}

export function getDiscordRpcCredentialStoreDescription() {
  return getDiscordRpcCredentialBackend() === "dpapi"
    ? "Windows DPAPI CurrentUser: %LOCALAPPDATA%\\personal-context-hub\\discord-rpc.dpapi"
    : getDiscordRpcCredentialPath();
}

function runDiscordRpcDpapi(action, input = "") {
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
          `Windows DPAPI Discord RPC credential operation failed (${code})${
            detail ? `: ${detail}` : ""
          }`,
        ),
      );
    });
    child.stdin.end(input);
  });
}

function validateCredential(credential) {
  if (!/^\d{17,20}$/.test(credential?.applicationId ?? "")) {
    throw new Error(
      "The Discord RPC credential has an invalid Application ID.",
    );
  }
  if (
    typeof credential.clientSecret !== "string" ||
    credential.clientSecret.length < 20 ||
    /\s/.test(credential.clientSecret)
  ) {
    throw new Error("The Discord RPC credential has an invalid Client Secret.");
  }
  return credential;
}

export async function readDiscordRpcCredentialStore(path) {
  let contents;
  try {
    contents =
      path || getDiscordRpcCredentialBackend() === "file"
        ? await readFile(path ?? getDiscordRpcCredentialPath(), "utf8")
        : await runDiscordRpcDpapi("read");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "Discord RPC is not configured. Store the separate Reader application's Client Secret first.",
      );
    }
    throw error;
  }
  return validateCredential(JSON.parse(contents));
}

export async function writeDiscordRpcCredentialStore(credential, path) {
  validateCredential(credential);
  const contents = `${JSON.stringify(credential, null, 2)}\n`;
  if (!path && getDiscordRpcCredentialBackend() === "dpapi") {
    await runDiscordRpcDpapi("write", contents);
    return;
  }

  const resolvedPath = path ?? getDiscordRpcCredentialPath();
  await mkdir(dirname(resolvedPath), { recursive: true });
  const temporaryPath = `${resolvedPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, contents, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, resolvedPath);
  await chmod(resolvedPath, 0o600).catch(() => undefined);
}
