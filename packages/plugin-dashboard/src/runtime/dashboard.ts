import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError, send } from "@ido/common/runtime/http";
import { pluginRuntime } from "@ido/common/runtime/plugin";
import { route } from "../api/routes.js";
import { dashboardManifest } from "../manifest.js";
const server = createServer(
  (req, res) =>
    void route(
      req,
      res,
      runtime.rpc,
      join(dirname(fileURLToPath(import.meta.url)), "ui"),
    ).catch((error) => {
      const code =
        error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "REQUEST_FAILED";
      send(
        res,
        error instanceof HttpError
          ? error.status
          : code === "LOGIN_REQUIRED"
            ? 401
            : code === "PERMISSION_DENIED"
              ? 403
              : 400,
        { error: code },
      );
    }),
);
const runtime = pluginRuntime(
  dashboardManifest,
  async (operation) => {
    if (["validate", "configure", "event", "output"].includes(operation))
      return { ok: true };
    if (operation !== "start") throw new Error("UNKNOWN_OPERATION");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    return {
      port: address && typeof address !== "string" ? address.port : undefined,
    };
  },
  () => new Promise<void>((resolve) => server.close(() => resolve())),
);
