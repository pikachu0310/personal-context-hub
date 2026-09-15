import type { IncomingMessage } from "node:http";
import type { User } from "@ido/common/contracts/protocol";
import { HttpError } from "@ido/common/runtime/http";
import { equal, hash } from "@ido/common/runtime/platform";
import type { Engine } from "../../bootstrap/engine.js";
export type Auth = { user: User; csrf: string; token: string };
export function config(this: Engine) {
  return {
    ...this.store.get<Record<string, string>>("config", "public"),
    ...this.store.get<Record<string, string>>("config", "engine"),
  };
}
export function authenticate(this: Engine, req: IncomingMessage): Auth {
  const token =
    (req.headers.cookie ?? "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("ido_session="))
      ?.slice(12) ?? "";
  const row = this.store.db
    .prepare("SELECT userId,csrf FROM sessions WHERE token=? AND expires>?")
    .get(hash(token), Date.now());
  const user = row && this.store.user(row.userId as string);
  if (!user) throw new HttpError(401, "LOGIN_REQUIRED");
  return { user, csrf: row!.csrf as string, token };
}
export function mutate(
  this: Engine,
  req: IncomingMessage,
  auth: Auth,
  admin = false,
) {
  if (!equal(String(req.headers["x-csrf-token"] ?? ""), auth.csrf))
    throw new HttpError(403, "CSRF_REQUIRED");
  if (auth.user.role === "viewer" || (admin && auth.user.role !== "admin"))
    throw new HttpError(403, "PERMISSION_DENIED");
}
