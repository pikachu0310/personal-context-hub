import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const isWsl =
  process.platform === "linux" &&
  (Boolean(process.env.WSL_DISTRO_NAME) ||
    existsSync(
      "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ));
const scriptPath = fileURLToPath(
  new URL("../scripts/agent-worker-dpapi.ps1", import.meta.url),
);
const dpapiScript = readFileSync(scriptPath, "utf8");

export function getAgentWorkerCredentialBackend(env = process.env) {
  if (env.PERSONAL_CONTEXT_AGENT_CREDENTIAL_PATH) return "file";
  if (env.PERSONAL_CONTEXT_AGENT_CREDENTIAL_BACKEND)
    return env.PERSONAL_CONTEXT_AGENT_CREDENTIAL_BACKEND;
  return process.platform === "win32" || isWsl ? "dpapi" : "file";
}

export function getAgentWorkerCredentialPath(env = process.env) {
  if (env.PERSONAL_CONTEXT_AGENT_CREDENTIAL_PATH)
    return env.PERSONAL_CONTEXT_AGENT_CREDENTIAL_PATH;
  const root = env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(root, "personal-context-hub", "agent-worker.json");
}

function runDpapi(action, input = "") {
  return new Promise((resolve, reject) => {
    const executable = isWsl
      ? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
      : "powershell.exe";
    const child = spawn(
      executable,
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
      if (code === 0) return resolve(Buffer.concat(stdout).toString("utf8"));
      reject(
        new Error(
          `Windows DPAPI Agent Worker credential operation failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ),
      );
    });
    child.stdin.end(input);
  });
}

function validate(value) {
  if (
    !value?.agentId ||
    !value?.token ||
    !value?.privateKey ||
    !value?.publicKey ||
    !/^wss?:\/\//.test(value?.gatewayUrl ?? "")
  )
    throw new Error("Agent Worker credential is invalid.");
  return value;
}

export async function readAgentWorkerCredential(env = process.env) {
  const contents =
    getAgentWorkerCredentialBackend(env) === "dpapi"
      ? await runDpapi("read")
      : await readFile(getAgentWorkerCredentialPath(env), "utf8");
  return validate(JSON.parse(contents));
}

export async function writeAgentWorkerCredential(
  credential,
  env = process.env,
) {
  validate(credential);
  const contents = `${JSON.stringify(credential, null, 2)}\n`;
  if (getAgentWorkerCredentialBackend(env) === "dpapi") {
    await runDpapi("write", contents);
    return;
  }
  const path = getAgentWorkerCredentialPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}
