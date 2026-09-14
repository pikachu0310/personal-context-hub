import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "../../../../common/src/contracts/protocol.js";
import { send } from "../../../../common/src/runtime/http.js";
import type { Engine } from "../../bootstrap/engine.js";
import type { Auth } from "./auth.js";
export async function tunnels(
  this: Engine,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  input: Record<string, any>,
  auth: Auth,
) {
  const admin = auth.user.role === "admin";
  switch (url.pathname) {
    case "/api/admin/tunnels/install":
      this.mutate(req, auth, true);
      await this.tunnels.install(text(input.provider, 30));
      break;
    case "/api/admin/tunnels/start":
      this.mutate(req, auth, true);
      if (input.token)
        await this.credentials.set(
          `tunnel.${text(input.provider, 30)}`,
          text(input.token, 8000),
        );
      await this.tunnels.start(
        text(input.provider, 30),
        { engine: Number(new URL(this.origin).port) },
        input.engineUrl ? text(input.engineUrl, 2048) : undefined,
      );
      break;
    case "/api/admin/tunnels/stop":
      this.mutate(req, auth, true);
      this.tunnels.stop();
      break;
    case "/api/admin/tunnels/doctor":
      this.mutate(req, auth, true);
      send(res, 200, await this.tunnels.diagnose());
      return true;
    default:
      return false;
  }
  send(res, 200, { ok: true });
  return true;
}
