import type { IncomingMessage, ServerResponse } from "node:http";
import { id } from "@ido/common/contracts/protocol";
import { send } from "@ido/common/runtime/http";
import type { Engine } from "../../bootstrap/engine.js";
import type { Auth } from "./auth.js";
export async function plugins(
  this: Engine,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  input: Record<string, any>,
  auth: Auth,
) {
  const admin = auth.user.role === "admin";
  switch (url.pathname) {
    case "/api/admin/plugins/forum": {
      this.mutate(req, auth, true);
      if (!["status", "recover"].includes(input.action))
        throw new Error("INVALID_FORUM_ACTION");
      const plugin = this.plugins.get("discord");
      if (plugin.status !== "running") throw new Error("DISCORD_NOT_RUNNING");
      const result = await plugin.request(
        `forum.${input.action}`,
        input.action === "status"
          ? {}
          : {
              projectId: id(input.projectId),
              taskId: id(input.taskId),
              threadId: input.threadId ? id(input.threadId) : undefined,
              recreate: input.recreate === true,
            },
      );
      send(res, 200, result);
      return true;
    }
    case "/api/admin/plugins/setup": {
      this.mutate(req, auth, true);
      const result = await this.plugins.setup(id(input.pluginId), input.config);
      send(res, 200, result);
      return true;
    }
    case "/api/admin/plugins/configure": {
      this.mutate(req, auth, true);
      await this.plugins.configure(id(input.pluginId), input.config);
      break;
    }
    default:
      return false;
  }
  send(res, 200, { ok: true });
  return true;
}
