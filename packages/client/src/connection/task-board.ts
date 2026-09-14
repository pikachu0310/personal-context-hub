import { randomUUID } from "node:crypto";
import type { Command, Task } from "@ido/common/contracts/protocol";

// Bound to the current Engine connection; no independent account or credentials.
export class TaskBoardConnection {
  supported = false;
  pending = new Map<
    string,
    {
      task: Task;
      finish: (error?: Error, value?: unknown) => void;
    }
  >();
  listeners = new Map<string, Set<(message: Command) => void>>();
  constructor(readonly send: (message: Command) => void) {}

  receive(message: Command) {
    if (message.type === "board.result") {
      const pending = this.pending.get(String(message.requestId));
      if (
        pending &&
        pending.task.id === message.taskId &&
        pending.task.runId === message.runId &&
        pending.task.revision === message.revision
      )
        pending.finish(
          message.error ? new Error(String(message.error)) : undefined,
          message.result,
        );
      return true;
    }
    if (message.type === "board.changed") {
      for (const notify of this.listeners.get(String(message.runId)) ?? [])
        notify(message);
      return true;
    }
    return false;
  }
  close() {
    this.supported = false;
    for (const pending of this.pending.values())
      pending.finish(new Error("BOARD_CONNECTION_CLOSED"));
  }
  forTask(task: Task, signal: AbortSignal) {
    const call = (
      operation: string,
      input: Record<string, unknown>,
      postKey?: string,
    ) =>
      new Promise<unknown>((resolve, reject) => {
        signal.throwIfAborted();
        if (!this.supported) throw new Error("BOARD_UNAVAILABLE");
        const requestId = randomUUID();
        const finish = (error?: Error, value?: unknown) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          this.pending.delete(requestId);
          error ? reject(error) : resolve(value);
        };
        const abort = () => finish(new Error("BOARD_EXECUTION_ENDED"));
        const timer = setTimeout(
          () => finish(new Error("BOARD_DELIVERY_UNKNOWN")),
          15000,
        );
        this.pending.set(requestId, { task: structuredClone(task), finish });
        signal.addEventListener("abort", abort, { once: true });
        try {
          this.send({
            v: 1,
            type: "board.request",
            requestId,
            taskId: task.id,
            runId: task.runId,
            revision: task.revision,
            operation,
            input,
            postKey,
          });
        } catch {
          finish(new Error("BOARD_UNAVAILABLE"));
        }
      });
    return {
      read: (input: Record<string, unknown>) => call("read", input),
      post: (input: Record<string, unknown>, postKey: string) =>
        call("post", input, postKey),
      subscribe: (notify: () => void) => {
        const listeners = this.listeners.get(task.runId) ?? new Set();
        this.listeners.set(task.runId, listeners);
        const listener = (message: Command) => {
          if (
            !signal.aborted &&
            message.taskId === task.id &&
            message.revision === task.revision
          )
            notify();
        };
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          if (!listeners.size) this.listeners.delete(task.runId);
        };
      },
    };
  }
}
