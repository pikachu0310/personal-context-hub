import OpenAI from "openai";
import type { Credentials } from "@ido/common/runtime/credentials";
import {
  CoordinatorDeliveryError,
  type CoordinatorFactory,
  type CoordinatorResponse,
  type CoordinatorRuntime,
} from "@ido/common/contracts/coordinator";
import { describeError } from "../../domain/diagnostics.js";
import {
  coordinatorPrompt,
  coordinatorSchema,
  parseCoordinatorResponse,
} from "./coordinator-prompt.js";

export interface OpenAICoordinatorOptions {
  credentials: Pick<Credentials, "get">;
  model?: string;
}

// SQLite owns the conversation context. Each request is self-contained and has
// no tools, remote conversation, Codex process, or separate login.
export function createOpenAICoordinatorFactory(
  options: OpenAICoordinatorOptions,
  { createClient = (apiKey: string) => new OpenAI({ apiKey }) } = {},
): CoordinatorFactory & { close(): Promise<void> } {
  const sessions = new Map<string, CoordinatorRuntime>();
  let factoryClosed = false;
  return {
    async createCoordinator({ meetingId, handle, onCheckpoint }) {
      if (factoryClosed)
        throw new CoordinatorDeliveryError("COORDINATOR_CLOSED", "rejected");
      if (!meetingId || (handle && handle.meetingId !== meetingId))
        throw new CoordinatorDeliveryError(
          "COORDINATOR_HANDLE_MISMATCH",
          "rejected",
        );
      if (sessions.has(meetingId))
        throw new CoordinatorDeliveryError(
          "COORDINATOR_ALREADY_OPEN",
          "rejected",
        );
      let closed = false;
      let checkpointed = false;
      let controller: AbortController | undefined;
      let operation: Promise<CoordinatorResponse> | undefined;
      let closing: Promise<void> | undefined;
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
          if (observation.meetingId !== meetingId)
            return Promise.reject(
              new CoordinatorDeliveryError(
                "COORDINATOR_MEETING_MISMATCH",
                "rejected",
              ),
            );
          if (JSON.stringify(observation).length > 64_000)
            return Promise.reject(
              new CoordinatorDeliveryError(
                "COORDINATOR_INPUT_TOO_LARGE",
                "rejected",
              ),
            );
          const value = structuredClone(observation);
          controller = new AbortController();
          const turnSignal = signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal;
          operation = Promise.resolve().then(async () => {
            let sent = false;
            try {
              turnSignal.throwIfAborted();
              // Read on every turn so correcting the admin API key takes effect
              // without recreating this meeting or restarting the Engine.
              const apiKey = await options.credentials.get("openai");
              if (!apiKey) throw new Error("OPENAI_KEY_REQUIRED");
              if (!checkpointed) {
                // Legacy Codex handles can be replaced without opening their
                // thread. Inbox recovery/permission checks remain authoritative.
                await onCheckpoint?.({
                  backend: "openai-responses",
                  meetingId,
                  threadId: meetingId,
                });
                checkpointed = true;
              }
              const api = createClient(apiKey);
              turnSignal.throwIfAborted();
              sent = true;
              const response = await api.responses.create(
                {
                  model: options.model ?? "gpt-4.1-mini",
                  ...((options.model ?? "gpt-4.1-mini").startsWith("gpt-4.1")
                    ? { temperature: 0 }
                    : {}),
                  store: false,
                  input: coordinatorPrompt(value, { initial: true }),
                  tools: [],
                  text: {
                    format: {
                      type: "json_schema",
                      name: "meeting_coordinator",
                      strict: true,
                      schema: coordinatorSchema,
                    },
                  },
                  max_output_tokens: 16000,
                },
                // This request has no tools or remote conversation state.
                // One SDK retry can recover a transient transport failure;
                // exhausted failures still stop at the inbox uncertainty guard.
                { signal: turnSignal, maxRetries: 1, timeout: 60_000 },
              );
              turnSignal.throwIfAborted();
              if (response.status !== "completed")
                throw new Error("COORDINATOR_RESPONSE_INCOMPLETE");
              const parsed = parseCoordinatorResponse(response.output_text);
              // Missing scores from a new API response are never a legacy work grant.
              // Saved responses bypass this adapter and retain their compatibility path.
              for (const task of parsed.tasks) task.evaluation ??= null;
              return parsed;
            } catch (error) {
              const detail = describeError(error);
              const rejected =
                !sent ||
                (detail.status !== undefined &&
                  [400, 401, 403, 404, 422, 429].includes(detail.status));
              // Retain only allowlisted diagnostic metadata; provider messages
              // can contain private inputs or credentials.
              throw Object.assign(
                new CoordinatorDeliveryError(
                  detail.code ??
                    (detail.status ? "COORDINATOR_HTTP_ERROR" : undefined) ??
                    (sent
                      ? "COORDINATOR_RESPONSE_UNCERTAIN"
                      : "COORDINATOR_NOT_STARTED"),
                  rejected ? "rejected" : "unknown",
                ),
                {
                  status: detail.status,
                  providerErrorType: detail.type,
                  requestID: detail.requestId,
                  param: detail.parameter,
                  cause: detail.cause ? { code: detail.cause } : undefined,
                },
              );
            } finally {
              operation = undefined;
              controller = undefined;
            }
          });
          return operation;
        },
        // HTTP requests cannot accept additional inputs. A definite rejection
        // leaves urgent inputs in the durable inbox for the next request.
        async steer() {
          return false;
        },
        async interrupt() {
          const pending = operation;
          controller?.abort();
          await pending?.catch(() => {});
        },
        close() {
          if (closing) return closing;
          closed = true;
          closing = runtime.interrupt().finally(() => {
            sessions.delete(meetingId);
          });
          return closing;
        },
      };
      sessions.set(meetingId, runtime);
      return runtime;
    },
    async close() {
      factoryClosed = true;
      await Promise.all(
        [...sessions.values()].map((runtime) => runtime.close()),
      );
    },
  };
}
