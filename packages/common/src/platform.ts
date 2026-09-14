import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  randomBytes,
  createHash,
  timingSafeEqual,
  scryptSync,
} from "node:crypto";

export const secret = () => randomBytes(32).toString("base64url");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function equal(a: string, b: string) {
  return (
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
export function passwordHash(value: string) {
  if (value.length < 12 || value.length > 1024)
    throw new Error("PASSWORD_MINIMUM_12_CHARACTERS");
  const salt = secret();
  return salt + ":" + scryptSync(value, salt, 64).toString("hex");
}
export function passwordMatches(value: string, saved: string) {
  const [salt, expected] = saved.split(":");
  return (
    value.length <= 1024 &&
    !!salt &&
    !!expected &&
    equal(scryptSync(value, salt, 64).toString("hex"), expected)
  );
}
export function dataDirectory(kind: "engine" | "client") {
  const base =
    process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : (process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));
  return resolve(process.env.IDO_DATA_DIR ?? join(base, "ido", kind));
}
export async function atomic(path: string, value: unknown) {
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + secret() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
}
export async function json<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}
export function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeout?: number;
  } = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PROCESS_TIMEOUT"));
    }, options.timeout ?? 30000);
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-1024 * 1024);
    });
    child.stderr.resume();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("PROCESS_UNAVAILABLE"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolvePromise(output.trim())
        : reject(new Error("PROCESS_FAILED"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}
export async function npmRun(
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
) {
  if (process.platform !== "win32") return run("npm", args, options);
  const { access } = await import("node:fs/promises");
  const { dirname, delimiter } = await import("node:path");
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .map((p) => join(p, "node_modules", "npm", "bin", "npm-cli.js")),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
    } catch {
      continue;
    }
    return run(process.execPath, [candidate, ...args], options);
  }
  throw new Error("NPM_NOT_FOUND");
}
export function openBrowser(url: string) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32.exe"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}
export function workerEnvironment(home: string): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LOCALAPPDATA",
    "APPDATA",
  ];
  return Object.fromEntries([
    ...allowed.filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
    ["CODEX_HOME", home],
  ]);
}
