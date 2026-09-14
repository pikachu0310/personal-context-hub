import type { Command, User } from "@ido/common/contracts/protocol";
import type { Diagnostic, DiagnosticContext } from "../domain/diagnostics.js";
export interface Repository {
  get<T>(kind: string, id: string): T | undefined;
  list<T>(kind: string): T[];
  entries(): Array<{ kind: string; id: string; value: any }>;
  put(kind: string, id: string, value: unknown): void;
  remove(kind: string, id: string): void;
  transaction<T>(fn: () => T): T;
  user(id: string): User | undefined;
  users(): User[];
  conversationAuthor(id: string): User | undefined;
  audit(actor: string, action: string, target: string): void;
  logError(error: unknown, context: DiagnosticContext): Diagnostic;
  requestTask(key: string): string | undefined;
  rememberRequest(key: string, taskId: string): void;
  enqueue(deviceId: string, command: Omit<Command, "v">): unknown;
  pending(deviceId: string): Command[];
  ack(deviceId: string, id: string): void;
}
