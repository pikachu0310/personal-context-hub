import { run, workerEnvironment } from "@ido/common/runtime/platform";
import { codexBinary } from "../execution/executor.js";
import type { Client } from "../bootstrap/client.js";
export async function checkAccount(this: Client) {
  try {
    await run(codexBinary(), ["login", "status"], {
      env: workerEnvironment(this.executor.home),
      timeout: 10000,
    });
    this.loginStatus = "authenticated";
  } catch {
    this.loginStatus = "login required";
  }
  if (!this.stopping) this.ready();
}
