import { randomUUID } from "node:crypto";
import type { User } from "@ido/common/contracts/protocol";
import type { Repository } from "../ports/repository.js";
export class Identities {
  constructor(readonly store: Repository) {}
  resolve(pluginId: string, subject: string): User | undefined {
    const key = `${pluginId}:${subject}`;
    const link = this.store.get<{ userId: string }>("external-identity", key);
    if (link) return this.store.user(link.userId);
    const known = this.store.get<{ actorId: string }>(
      "external-participant",
      key,
    );
    if (known) return this.store.get<User>("participant", known.actorId);
    const actor = {
      id: randomUUID(),
      name: `${pluginId} ${subject}`,
      role: "member" as const,
    };
    this.store.put("participant", actor.id, actor);
    this.store.put("external-participant", key, { actorId: actor.id });
    return actor;
  }
  linked(pluginId: string, subject: string) {
    const link = this.store.get<{ userId: string }>(
      "external-identity",
      `${pluginId}:${subject}`,
    );
    return link && this.store.user(link.userId);
  }
  link(pluginId: string, subject: string, userId: string) {
    if (!this.store.user(userId)) throw new Error("USER_NOT_FOUND");
    const key = `${pluginId}:${subject}`;
    const previous = this.store.get<{ userId: string }>(
      "external-identity",
      key,
    );
    if (previous && previous.userId !== userId)
      throw new Error("IDENTITY_ALREADY_LINKED");
    this.store.put("external-identity", key, { userId });
  }
}
