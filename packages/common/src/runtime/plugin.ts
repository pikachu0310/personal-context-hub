import {
  PLUGIN_PROTOCOL,
  type PluginFrame,
  type PluginManifest,
} from "../contracts/plugins.js";
import { Rpc } from "./rpc.js";
export function pluginRuntime(
  manifest: PluginManifest,
  handler: (
    operation: string,
    input: Record<string, unknown>,
    context?: string,
  ) => Promise<unknown>,
  close: () => Promise<void> | void,
) {
  const send = (frame: PluginFrame) => {
    if (process.connected) process.send?.(frame);
  };
  const rpc = new Rpc(send, async (op, input, context) =>
    op === "inspect" ? manifest : handler(op, input, context),
  );
  process.on("message", (raw) => {
    void rpc.receive(raw).catch(() => {
      process.exitCode = 1;
      void shutdown();
    });
  });
  const shutdown = async () => {
    rpc.close();
    await close();
    process.exit();
  };
  process.once("disconnect", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  return {
    rpc,
    emit: (type: string, data: Record<string, unknown> = {}) =>
      send({ ...data, type, v: PLUGIN_PROTOCOL }),
  };
}
