import { randomUUID } from "node:crypto";
import type { Repository } from "../ports/repository.js";
export class Contexts {
  private values = new Map<
    string,
    {
      pluginId: string;
      userId: string;
      generation: number;
      expires: number;
      scope: "member" | "activity";
      valid: () => boolean;
    }
  >();
  constructor(readonly store: Repository) {}
  issue(
    pluginId: string,
    userId: string,
    generation: number,
    scope: "member" | "activity",
    valid: () => boolean = () => true,
  ) {
    for (const [key, entry] of this.values)
      if (entry.expires < Date.now() || !entry.valid()) this.values.delete(key);
    const token = randomUUID();
    this.values.set(token, {
      pluginId,
      userId,
      generation,
      scope,
      expires: Date.now() + (scope === "activity" ? 3600000 : 300000),
      valid,
    });
    return token;
  }
  resolve(pluginId: string, generation: number, token?: string) {
    const entry = token && this.values.get(token);
    if (
      !entry ||
      entry.pluginId !== pluginId ||
      entry.generation !== generation ||
      entry.expires < Date.now() ||
      !entry.valid()
    )
      throw new Error("LOGIN_REQUIRED");
    const user = this.store.user(entry.userId);
    if (!user) throw new Error("LOGIN_REQUIRED");
    return { user, scope: entry.scope };
  }
}
