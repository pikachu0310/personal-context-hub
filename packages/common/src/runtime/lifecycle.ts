import { mkdir, open, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { send } from "./http.js";
import { equal, secret } from "./platform.js";

export async function control(directory: string, action: "stop" | "status") {
  try {
    const state = JSON.parse(
      await readFile(join(directory, "runtime.json"), "utf8"),
    );
    const response = await fetch(`http://127.0.0.1:${state.port}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error("UNAVAILABLE");
    return await response.json();
  } catch {
    return { running: false };
  }
}
export async function lifetime(directory: string, stop: () => Promise<void>) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "runtime.json");
  if ((await control(directory, "status")).running)
    throw new Error("ALREADY_RUNNING");
  // An exclusive lock survives a racing pair of start commands. Stale locks require doctor recovery.
  const lock = await open(join(directory, "runtime.lock"), "wx", 0o600).catch(
    () => {
      throw new Error(
        "START_LOCK_EXISTS: run doctor --recover after confirming the previous process has stopped",
      );
    },
  );
  const token = secret();
  let closing = false;
  const server = createServer((req, res) => {
    if (
      req.headers.origin ||
      req.method !== "POST" ||
      !equal(req.headers.authorization ?? "", `Bearer ${token}`)
    ) {
      send(res, 403, {});
      return;
    }
    send(res, 200, { running: true, pid: process.pid });
    if (req.url === "/stop") void close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await (
    await import("./platform.js")
  ).atomic(path, {
    port: typeof address === "object" && address ? address.port : 0,
    token,
    pid: process.pid,
  });
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await stop();
    } catch (error) {
      // A failed shutdown still owns the lock and must be retryable by the UI.
      closing = false;
      throw error;
    }
    server.close();
    await rm(path, { force: true });
    await lock.close();
    await rm(join(directory, "runtime.lock"), { force: true });
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  return close;
}
export async function recover(directory: string) {
  if ((await control(directory, "status")).running)
    throw new Error("STILL_RUNNING");
  try {
    const state = JSON.parse(
      await readFile(join(directory, "runtime.json"), "utf8"),
    );
    try {
      process.kill(state.pid, 0);
      throw new Error("PROCESS_STILL_EXISTS");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await rm(join(directory, "runtime.lock"), { force: true });
  await rm(join(directory, "runtime.json"), { force: true });
}
