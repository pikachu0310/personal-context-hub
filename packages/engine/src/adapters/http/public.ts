import type { IncomingMessage, ServerResponse } from "node:http";
import { endpoint, text } from "../../../../common/src/contracts/protocol.js";
import { HttpError, send } from "../../../../common/src/runtime/http.js";
import type { Engine } from "../../bootstrap/engine.js";
import type { Auth } from "./auth.js";
export async function publicRoutes(
  this: Engine,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  input: Record<string, any>,
  auth: Auth,
) {
  const admin = auth.user.role === "admin";
  switch (url.pathname) {
    case "/api/admin/public": {
      this.mutate(req, auth, true);
      const engineUrl = endpoint(input.engineUrl).origin;
      if (!engineUrl.startsWith("https:"))
        throw new HttpError(400, "PUBLIC_HTTPS_REQUIRED");
      if (!["ngrok", "cloudflare", "manual"].includes(input.provider))
        throw new HttpError(400, "INVALID_PROVIDER");
      this.store.put("config", "public", {
        engineUrl,
        provider: text(input.provider, 30),
      });
      this.store.audit(auth.user.id, "public.update", "origins");
      break;
    }
    case "/api/admin/doctor/openai":
      this.mutate(req, auth, true);
      send(res, 200, await this.conversation.doctor());
      return true;
    default:
      return false;
  }
  send(res, 200, { ok: true });
  return true;
}
