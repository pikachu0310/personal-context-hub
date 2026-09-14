import { createRequire } from "node:module";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
let child: ChildProcess | undefined;
let cleanup: () => Promise<unknown> = async () => {};
process.once("message", (config: any) => {
  void (async () => {
    const require = createRequire(join(config.directory, "package.json"));
    if (config.provider === "ngrok") {
      const ngrok = require("@ngrok/ngrok");
      await ngrok.forward({
        addr: `127.0.0.1:${config.ports.engine}`,
        authtoken: config.secret,
        domain: new URL(config.engineUrl).hostname,
      });
      await ngrok.forward({
        addr: `127.0.0.1:${config.ports.preview}`,
        authtoken: config.secret,
        domain: new URL(config.previewUrl).hostname,
      });
      cleanup = () => ngrok.disconnect();
    } else if (config.provider === "cloudflare") {
      const cloudflared = require("cloudflared");
      const binary = join(
        config.directory,
        process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
      );
      await cloudflared.install(binary);
      const tokenFile = join(config.directory, "token");
      await writeFile(tokenFile, config.secret, { mode: 0o600 });
      child = spawn(
        binary,
        ["tunnel", "--no-autoupdate", "run", "--token-file", tokenFile],
        { stdio: "ignore", windowsHide: true },
      );
      cleanup = async () => {
        child?.kill();
        await rm(tokenFile, { force: true });
      };
      child.once("error", () =>
        process.send?.({ type: "status", status: "failed" }),
      );
      child.once("exit", () => {
        void cleanup().finally(() => process.exit(0));
      });
    } else throw new Error("INVALID_PROVIDER");
    process.send?.({ type: "status", status: "running; diagnostics required" });
  })().catch(() => {
    process.send?.({ type: "status", status: "failed" });
    process.exitCode = 1;
  });
});
const close = () => void cleanup().finally(() => process.exit(0));
process.once("SIGTERM", close);
process.once("disconnect", close);
