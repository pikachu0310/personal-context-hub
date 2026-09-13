import { AppServerCodex } from "./execution/codex/app-server.mjs";
import { buildCodexOptions } from "./execution/codex/runner.mjs";
import { codexBinary } from "./codex-binary.mjs";

export class AgentSandboxSetup {
  constructor(
    codexHome,
    {
      supported = process.platform === "win32",
      createClient = (options) => new AppServerCodex(options),
    } = {},
  ) {
    this.codexHome = codexHome;
    this.createClient = createClient;
    this.state = { supported, pending: false };
  }
  start(cwd) {
    if (!this.state.supported || this.state.pending) return;
    this.state = { supported: true, pending: true };
    const client = (this.client = this.createClient({
      ...buildCodexOptions(process.env, this.codexHome),
      codexPathOverride: codexBinary(),
    }));
    let timer;
    const completed = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Setup timeout")), 300000);
      client.on("failure", reject);
      client.on("notification", (event) => {
        if (event.method === "windowsSandbox/setupCompleted")
          event.params.success ? resolve() : reject(new Error("Setup failed"));
      });
    });
    // Attach immediately: startup failures can precede the request response.
    completed.catch(() => {});
    this.done = (async () => {
      try {
        await client.request("windowsSandbox/setupStart", {
          mode: "elevated",
          cwd,
        });
        await completed;
        await client.request("config/value/write", {
          keyPath: "windows.sandbox",
          value: "elevated",
          mergeStrategy: "replace",
        });
        this.state = { supported: true, pending: false, ready: true };
      } catch {
        this.state = {
          supported: true,
          pending: false,
          error:
            "セットアップを完了できませんでした。Windowsの管理者確認と端末の管理ポリシーを確認してください。",
        };
      } finally {
        clearTimeout(timer);
        await client.close();
        this.client = undefined;
      }
    })();
  }
  async close() {
    await this.client?.close();
    await this.done;
  }
}
