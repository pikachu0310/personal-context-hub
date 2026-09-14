import type { IncomingMessage, ServerResponse } from "node:http";
import { id, text, type User } from "@ido/common/contracts/protocol";
import { HttpError, send } from "@ido/common/runtime/http";
import type { Engine } from "../../bootstrap/engine.js";
import type { Device } from "../../domain/models.js";
import type { Auth } from "./auth.js";
export async function members(
  this: Engine,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  input: Record<string, any>,
  auth: Auth,
) {
  const admin = auth.user.role === "admin";
  switch (url.pathname) {
    case "/api/admin/users":
      this.mutate(req, auth, true);
      if (!["admin", "member", "viewer"].includes(String(input.role)))
        throw new HttpError(400, "INVALID_ROLE");
      this.store.createUser(
        text(input.name, 100),
        text(input.password, 1024),
        input.role as User["role"],
      );
      break;
    case "/api/admin/users/role": {
      this.mutate(req, auth, true);
      const userId = id(input.userId);
      if (
        userId === auth.user.id ||
        !["admin", "member", "viewer"].includes(String(input.role))
      )
        throw new HttpError(400, "INVALID_ROLE_CHANGE");
      this.store.db
        .prepare("UPDATE users SET role=? WHERE id=?")
        .run(String(input.role), userId);
      this.store.db.prepare("DELETE FROM sessions WHERE userId=?").run(userId);
      for (const device of this.store
        .list<Device>("device")
        .filter((d) => d.userId === userId)) {
        this.ready.delete(device.id);
        this.peers.get(device.id)?.close(4003, "permissions changed");
      }
      this.store.audit(auth.user.id, "user.role", userId);
      break;
    }
    case "/api/admin/devices/revoke": {
      const device = this.store.get<Device>("device", id(input.deviceId));
      if (!device || (device.userId !== auth.user.id && !admin))
        throw new HttpError(403, "PERMISSION_DENIED");
      device.revoked = true;
      this.store.put("device", device.id, device);
      this.ready.delete(device.id);
      this.peers.get(device.id)?.close(4003, "revoked");
      this.store.audit(auth.user.id, "device.revoke", device.id);
      break;
    }
    default:
      return false;
  }
  send(res, 200, { ok: true });
  return true;
}
