import { workerEnvironment } from "@ido/common/runtime/platform";
import type { ClientAccount } from "@ido/common/contracts/api";
import { AppServerCodex } from "../codex/app-server.mjs";
import { codexBinary } from "../codex/binary.js";
import type { Client } from "../bootstrap/client.js";
interface AccountReader {
  request(method: string, params: unknown): Promise<any>;
  close(): Promise<void>;
}
export async function readAccount(
  home: string,
  create = (): AccountReader =>
    new AppServerCodex(
      {
        codexPathOverride: codexBinary(),
        env: workerEnvironment(home),
      },
      { requestTimeoutMs: 10000 },
    ),
  timeoutMs = 10000,
): Promise<ClientAccount> {
  let reader: AccountReader | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = create();
    const response = await Promise.race([
      reader.request("account/read", { refreshToken: false }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("ACCOUNT_TIMEOUT")),
          timeoutMs,
        );
      }),
    ]);
    if (response?.account === null) return { status: "signed-out" };
    const account = response?.account;
    if (!["chatgpt", "apiKey", "amazonBedrock"].includes(account?.type))
      return { status: "unavailable" };
    // Explicit projection: never return raw RPC output or credentials.
    return {
      status: "available",
      type: account.type,
      ...(account.type === "chatgpt" && typeof account.email === "string"
        ? { email: account.email.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 320) }
        : {}),
    };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
    await reader?.close().catch(() => {});
  }
}
export async function checkAccount(this: Client) {
  if (this.stopping) return;
  if (this.accountCheck) return this.accountCheck;
  this.accountCheck = (async () => {
    const account = await readAccount(this.executor.home);
    if (this.stopping) return;
    this.account = account;
    if (account.status === "available") this.loginStatus = "authenticated";
    else if (account.status === "signed-out")
      this.loginStatus = "login required";
    this.ready();
  })().finally(() => {
    this.accountCheck = undefined;
  });
  return this.accountCheck;
}
