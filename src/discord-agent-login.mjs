import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { buildCodexEnvironment } from "./execution/codex/runner.mjs";

export class AgentBrowserLogin {
  constructor({ spawnProcess = spawn, launcher, env = process.env } = {}) {
    this.spawnProcess = spawnProcess;
    this.launcher = launcher;
    this.env = buildCodexEnvironment(env, env.CODEX_HOME);
    this.state = { authenticated: false, pending: false };
  }

  command(args) {
    const require = createRequire(import.meta.url);
    const cpu = { x64: "x86_64", arm64: "aarch64" }[process.arch];
    const target = {
      win32: "pc-windows-msvc",
      darwin: "apple-darwin",
      linux: "unknown-linux-musl",
    }[process.platform];
    const launcher =
      this.launcher ??
      join(
        dirname(
          require.resolve(
            `@openai/codex-${process.platform}-${process.arch}/package.json`,
          ),
        ),
        "vendor",
        `${cpu}-${target}`,
        "bin",
        process.platform === "win32" ? "codex.exe" : "codex",
      );
    return this.spawnProcess(launcher, args, {
      env: this.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  async refresh() {
    if (this.stopped) return { ...this.state };
    if (this.checking) return this.checking;
    this.checking = new Promise((resolve) => {
      const child = this.command(["login", "status"]);
      this.checkChild = child;
      // Do not return CLI output: API-key status can contain key material.
      child.stdout.resume();
      child.stderr.resume();
      const timer = setTimeout(() => child.kill(), 10_000);
      const finish = (code) => {
        if (this.checkChild === child) this.checkChild = undefined;
        clearTimeout(timer);
        this.state.authenticated = code === 0;
        resolve({ ...this.state });
      };
      child.once("error", () => finish(1));
      child.once("close", finish);
    })
      .catch(() => {
        this.state.authenticated = false;
        return { ...this.state };
      })
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }

  start() {
    if (this.stopped) return;
    if (this.child) return;
    const child = this.command(["login"]);
    this.state = { authenticated: false, pending: true };
    this.child = child;
    let output = "";
    const capture = (chunk) => {
      output = (output + chunk.toString("utf8")).slice(-32_768);
      // The official CLI opens the browser. Provide its URL only as a local
      // fallback, without inventing an OAuth client or reading auth.json.
      for (const candidate of output.match(/https:\/\/[^\s<>"']+/g) ?? []) {
        try {
          const url = new URL(candidate);
          if (
            url.origin === "https://auth.openai.com" &&
            !url.username &&
            !url.password
          )
            this.state.loginUrl = url.href;
        } catch {
          /* An incomplete stream chunk is not a URL yet. */
        }
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    const finish = () => {
      if (this.child !== child) return;
      clearTimeout(timer);
      this.child = undefined;
      output = "";
      this.state.pending = false;
      delete this.state.loginUrl;
      void this.refresh();
    };
    child.once("error", finish);
    child.once("close", finish);
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
    this.checkChild?.kill();
  }
}
