import { randomUUID } from "node:crypto";
import {
  PLUGIN_PROTOCOL,
  pluginFrame,
  type PluginFrame,
} from "../contracts/plugins.js";
export class Rpc {
  private pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    readonly send: (frame: PluginFrame) => void,
    readonly handler: (
      operation: string,
      input: Record<string, unknown>,
      context?: string,
    ) => Promise<unknown>,
  ) {}
  request<T = unknown>(
    operation: string,
    input: Record<string, unknown> = {},
    context?: string,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("PLUGIN_TIMEOUT"));
      }, 65000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.send({
          v: PLUGIN_PROTOCOL,
          type: "request",
          id,
          operation,
          input,
          context,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async receive(raw: unknown) {
    const frame = pluginFrame(raw);
    if (frame.type === "reply") {
      const pending = this.pending.get(String(frame.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(frame.id));
      if (frame.error) pending.reject(new Error(String(frame.error)));
      else pending.resolve(frame.result);
    } else if (frame.type === "request") {
      try {
        const result = await this.handler(
          String(frame.operation),
          (frame.input ?? {}) as Record<string, unknown>,
          typeof frame.context === "string" ? frame.context : undefined,
        );
        this.send({ v: PLUGIN_PROTOCOL, type: "reply", id: frame.id, result });
      } catch (error) {
        const message =
          error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "PLUGIN_REQUEST_FAILED";
        this.send({
          v: PLUGIN_PROTOCOL,
          type: "reply",
          id: frame.id,
          error: message,
        });
      }
    }
  }
  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("PLUGIN_STOPPED"));
    }
    this.pending.clear();
  }
}
