import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CoordinatorDeliveryError,
  type CoordinatorFactory,
  type CoordinatorObservation,
  type CoordinatorResponse,
  type CoordinatorRuntime,
} from "../../../../common/src/contracts/coordinator.js";
import { AppServerCodex } from "../../../../common/src/runtime/codex/app-server.mjs";
import { codexBinary } from "../../../../common/src/runtime/codex/binary.js";
import { workerEnvironment } from "../../../../common/src/runtime/platform.js";
import {
  coordinatorPrompt,
  coordinatorSchema,
  parseCoordinatorResponse,
} from "./prompt.js";

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: { type: string; text?: string; phase?: string };
  error?: { message?: string };
  message?: string;
}
interface CodexThread {
  readonly id?: string | null;
  prepare(): Promise<void>;
  runStreamed(
    prompt: string,
    options: { signal: AbortSignal; outputSchema: unknown },
  ): Promise<{ events: AsyncIterable<CodexEvent> }>;
  steer(prompt: string): Promise<boolean>;
  dispose(): Promise<void>;
}
export interface CoordinatorDriver {
  startThread(options: Record<string, unknown>): CodexThread;
  resumeThread(id: string, options: Record<string, unknown>): CodexThread;
  close(): Promise<void>;
}
export interface CodexCoordinatorOptions {
  directory: string;
  workingDirectory?: string;
  codexHome?: string;
  codexExecutable?: string;
  model?: string;
  reasoningEffort?: string;
}

// One Engine-owned process/thread per meeting. Model credentials and threads
// remain independent of task Clients; a cancelled meeting cannot kill a worker.
export function createCodexCoordinatorFactory(
  options: CodexCoordinatorOptions,
  {
    createDriver = (config) =>
      new AppServerCodex(config) as unknown as CoordinatorDriver,
  }: {
    createDriver?: (config: Record<string, unknown>) => CoordinatorDriver;
  } = {},
): CoordinatorFactory & { readonly codexHome: string; close(): Promise<void> } {
  const codexHome = resolve(
    options.codexHome ?? join(options.directory, "codex"),
  );
  const workingDirectory = resolve(
    options.workingDirectory ??
      join(options.directory, "coordinator-workspace"),
  );
  const sessions = new Map<string, CoordinatorRuntime>();
  let factoryClosed = false;
  return {
    codexHome,
    async createCoordinator({ meetingId, handle, onCheckpoint }) {
      if (factoryClosed)
        throw new CoordinatorDeliveryError("COORDINATOR_CLOSED", "rejected");
      if (
        !meetingId ||
        (handle &&
          (handle.meetingId !== meetingId ||
            handle.backend !== "codex" ||
            !handle.threadId))
      )
        throw new CoordinatorDeliveryError(
          "COORDINATOR_HANDLE_MISMATCH",
          "rejected",
        );
      if (sessions.has(meetingId))
        throw new CoordinatorDeliveryError(
          "COORDINATOR_ALREADY_OPEN",
          "rejected",
        );
      let driver: CoordinatorDriver | undefined;
      let thread: CodexThread | undefined;
      let initialized = false;
      let closed = false;
      let checkpointedId: string | undefined;
      let preparing: Promise<CodexThread> | undefined;
      let operation: Promise<CoordinatorResponse> | undefined;
      let controller: AbortController | undefined;
      let closing: Promise<void> | undefined;
      const checkpoint = async (threadId = thread?.id) => {
        if (!threadId || checkpointedId === threadId) return;
        await onCheckpoint?.({ backend: "codex", meetingId, threadId });
        checkpointedId = threadId;
      };
      const prepare = () => {
        preparing ??= (async () => {
          await mkdir(codexHome, { recursive: true, mode: 0o700 });
          await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
          driver = createDriver({
            codexPathOverride: options.codexExecutable ?? codexBinary(),
            env: workerEnvironment(codexHome),
            config: {
              approval_policy: "never",
              sandbox_mode: "read-only",
              web_search: "disabled",
              mcp_servers: {},
              apps: {
                _default: {
                  enabled: false,
                  destructive_enabled: false,
                  open_world_enabled: false,
                },
              },
              features: {
                shell_tool: false,
                unified_exec: false,
                apps: false,
                browser_use: false,
                computer_use: false,
                in_app_browser: false,
                hooks: false,
                memories: false,
                multi_agent: false,
                plugins: false,
                remote_plugin: false,
                skill_mcp_dependency_install: false,
              },
              notify: [],
            },
          });
          const settings = {
            workingDirectory,
            sandboxMode: "read-only",
            approvalPolicy: "never",
            networkAccessEnabled: false,
            webSearchMode: "disabled",
            disableShellTool: true,
            model: options.model ?? "gpt-5.6-sol",
            modelReasoningEffort: options.reasoningEffort ?? "low",
          };
          thread = handle
            ? driver.resumeThread(handle.threadId, settings)
            : driver.startThread(settings);
          await thread.prepare();
          return thread;
        })().catch(async () => {
          await driver?.close().catch(() => {});
          driver = undefined;
          thread = undefined;
          preparing = undefined;
          throw new CoordinatorDeliveryError(
            "COORDINATOR_UNAVAILABLE_CHECK_ENGINE_CODEX_LOGIN",
            "rejected",
          );
        });
        return preparing;
      };
      const input = (value: CoordinatorObservation) => {
        if (value.meetingId !== meetingId)
          throw new CoordinatorDeliveryError(
            "COORDINATOR_MEETING_MISMATCH",
            "rejected",
          );
        if (JSON.stringify(value).length > 64_000)
          throw new CoordinatorDeliveryError(
            "COORDINATOR_INPUT_TOO_LARGE",
            "rejected",
          );
        return structuredClone(value);
      };
      const runtime: CoordinatorRuntime = {
        run(observation, { signal } = {}) {
          if (closed)
            return Promise.reject(
              new CoordinatorDeliveryError("COORDINATOR_CLOSED", "rejected"),
            );
          if (operation)
            return Promise.reject(
              new CoordinatorDeliveryError("COORDINATOR_BUSY", "rejected"),
            );
          const value = input(observation);
          controller = new AbortController();
          const turnSignal = signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal;
          operation = Promise.resolve().then(async () => {
            let sent = false;
            try {
              turnSignal.throwIfAborted();
              const current = await prepare();
              await checkpoint();
              turnSignal.throwIfAborted();
              sent = true;
              const { events } = await current.runStreamed(
                coordinatorPrompt(value, { initial: !initialized }),
                { signal: turnSignal, outputSchema: coordinatorSchema },
              );
              let final = "",
                completed = false;
              for await (const event of events) {
                if (event.type === "thread.started")
                  await checkpoint(event.thread_id);
                if (event.type === "turn.started") initialized = true;
                if (
                  event.type === "item.completed" &&
                  event.item?.type === "agent_message" &&
                  event.item.phase !== "commentary"
                )
                  final = event.item.text ?? "";
                if (event.type === "turn.completed") completed = true;
                if (event.type === "turn.failed" || event.type === "error")
                  throw new Error("COORDINATOR_TURN_FAILED");
              }
              turnSignal.throwIfAborted();
              if (!completed) throw new Error("COORDINATOR_TURN_INCOMPLETE");
              const response = parseCoordinatorResponse(final);
              initialized = true;
              return response;
            } catch (error) {
              if (error instanceof CoordinatorDeliveryError) throw error;
              throw new CoordinatorDeliveryError(
                sent
                  ? "COORDINATOR_RESPONSE_UNCERTAIN"
                  : "COORDINATOR_NOT_STARTED",
                sent ? "unknown" : "rejected",
              );
            } finally {
              operation = undefined;
              controller = undefined;
            }
          });
          return operation;
        },
        async steer(observation) {
          const value = input(observation);
          if (closed || !operation || !thread) return false;
          try {
            return await thread.steer(
              coordinatorPrompt(value, { steering: true }),
            );
          } catch {
            throw new CoordinatorDeliveryError(
              "COORDINATOR_STEER_UNCERTAIN",
              "unknown",
            );
          }
        },
        async interrupt() {
          const pending = operation;
          if (!pending) return;
          controller?.abort(new Error("COORDINATOR_INTERRUPTED"));
          await pending.catch(() => {});
        },
        close() {
          if (closing) return closing;
          closed = true;
          closing = (async () => {
            try {
              await runtime.interrupt();
              await preparing?.catch(() => {});
              await thread?.dispose();
            } finally {
              try {
                await driver?.close();
              } finally {
                sessions.delete(meetingId);
              }
            }
          })();
          return closing;
        },
      };
      sessions.set(meetingId, runtime);
      return runtime;
    },
    async close() {
      factoryClosed = true;
      await Promise.allSettled(
        [...sessions.values()].map((runtime) => runtime.close()),
      );
    },
  };
}
