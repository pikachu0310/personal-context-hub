import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

const isWsl =
  process.platform === "linux" &&
  (Boolean(process.env.WSL_DISTRO_NAME) ||
    existsSync(
      "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ));

export function defaultCredentialBackend() {
  return process.platform === "win32" || isWsl ? "dpapi" : "file";
}

function runDpapi(script, operationName, action, input = "") {
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
          `$env:PERSONAL_CONTEXT_DPAPI_ACTION = '${action}';\n${script}`,
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
          `Windows DPAPI ${operationName} operation failed (${code})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
    child.stdin.end(input);
  });
}

// Each integration owns its schema, configuration, DPAPI script and error guidance.
// Storage owns JSON serialization, backend routing and atomic file replacement.
export function createCredentialStore({
  getBackend,
  getPath,
  dpapiScript,
  operationName,
}) {
  const script = readFileSync(dpapiScript, "utf8");
  return {
    async read(path) {
      const contents =
        path || getBackend() === "file"
          ? await readFile(path ?? getPath(), "utf8")
          : await runDpapi(script, operationName, "read");
      return JSON.parse(contents);
    },
    async write(credential, path) {
      const contents = `${JSON.stringify(credential, null, 2)}\n`;
      if (!path && getBackend() === "dpapi") {
        await runDpapi(script, operationName, "write", contents);
        return;
      }

      const resolvedPath = path ?? getPath();
      await mkdir(dirname(resolvedPath), { recursive: true });
      const temporaryPath = `${resolvedPath}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporaryPath, contents, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, resolvedPath);
      await chmod(resolvedPath, 0o600).catch(() => undefined);
    },
  };
}
