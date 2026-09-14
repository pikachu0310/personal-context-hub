import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { id, text, type Task } from "@ido/common/contracts/protocol";
import { HttpError } from "@ido/common/runtime/http";
import { run } from "@ido/common/runtime/platform";
import type { Client } from "../bootstrap/client.js";
import type { Run } from "./executor.js";
import { activityText } from "./activity.js";
import { selectedModel } from "../agents/model-selection.js";

/** Local-only projection for a future opt-in Bot adapter, never sent to Engine. */
export function localProgress(runs: Record<string, Run>) {
  return {
    schemaVersion: 1,
    sharing: "not-connected",
    tasks: Object.values(runs)
      .filter((value) => value.origin === "local")
      .map((value) => {
        const summary = {
          taskId: value.task.id,
          runId: value.task.runId,
          revision: value.task.revision,
          agent: value.agent ?? "codex",
          model: value.model,
          state: value.state,
          phase: value.phase,
          progressMode: value.progressMode,
          title: activityText(value.task.title ?? "", 300),
          updatedAt: value.updatedAt ?? value.task.updatedAt,
          progress: activityText(value.progress ?? "", 1000),
        };
        return {
          ...summary,
          changeToken: createHash("sha256")
            .update(JSON.stringify(summary))
            .digest("hex"),
        };
      }),
  };
}

export async function startLocalTask(
  client: Client,
  input: Record<string, unknown>,
) {
  const requestKey = id(input.requestKey);
  const runId = `local-${createHash("sha256").update(requestKey).digest("hex").slice(0, 32)}`;
  // Serialize admission with remote task reception so slots cannot be overbooked.
  const operation = client.processing
    .catch(() => {})
    .then(async () => {
      const previous = client.executor.runs[runId];
      if (previous?.origin === "local") return { runId };
      if (previous) throw new HttpError(409, "TASK_ORIGIN_MISMATCH");
      const instruction = text(input.text, 16000);
      const agent = input.agent ?? "codex";
      let model: string | undefined;
      try {
        model = selectedModel(input.model);
      } catch {
        throw new HttpError(400, "INVALID_MODEL");
      }
      if (agent !== "codex" && agent !== "claude")
        throw new HttpError(400, "INVALID_AGENT");
      const available = (await client.agentCatalog()).find(
        (value) => value.agent === agent,
      );
      if (!available?.authenticated)
        throw new HttpError(409, "AGENT_LOGIN_REQUIRED");
      if (!model || !available.models.some((value) => value.id === model))
        throw new HttpError(409, "MODEL_UNAVAILABLE");
      if (agent === "claude" && input.claudePermissionsAcknowledged !== true)
        throw new HttpError(400, "CLAUDE_PERMISSIONS_REQUIRED");
      const title = text(input.title || instruction.slice(0, 100), 200);
      if (!["auto", "manual"].includes(String(input.mode)))
        throw new HttpError(400, "INVALID_PROGRESS_MODE");
      if (!["workspace-write", "read-only"].includes(String(input.sandboxMode)))
        throw new HttpError(400, "INVALID_SANDBOX_MODE");
      const directory = await realpath(text(input.directory, 4000));
      try {
        await run("git", ["-C", directory, "rev-parse", "--show-toplevel"]);
        await run("git", ["-C", directory, "rev-parse", "--verify", "HEAD"]);
      } catch {
        throw new HttpError(400, "COMMITTED_REPOSITORY_REQUIRED");
      }
      const projectId = `local-${createHash("sha256").update(directory).digest("hex").slice(0, 24)}`;
      const mapping = {
        projectId,
        directory,
        network: input.network === true,
        slots: client.settings.slots,
      };
      const now = Date.now();
      const task: Task = {
        id: runId,
        runId,
        requestId: requestKey,
        projectId,
        meetingId: "local",
        authorId: "local",
        text: instruction,
        title,
        state: "assigned",
        revision: 1,
        network: mapping.network,
        executionPolicy: {
          sandboxMode: input.sandboxMode as "workspace-write" | "read-only",
          networkAccessEnabled: mapping.network,
        },
        createdAt: now,
        updatedAt: now,
        history: [],
      };
      await client.executor.receive(
        {
          v: 1,
          type: "execute",
          id: `start-${runId}`,
          taskId: task.id,
          runId,
          task,
        },
        [mapping],
        true,
        client.settings.slots,
        { progressMode: input.mode as "auto" | "manual", agent, model },
      );
      if (!client.executor.runs[runId])
        throw new HttpError(409, "LOCAL_SLOTS_FULL");
      return { runId };
    });
  client.processing = operation;
  return operation;
}

export async function localInstruction(
  client: Client,
  runId: string,
  requestKey: string,
  instruction: string,
) {
  const value = client.executor.runs[runId];
  if (!value || value.origin !== "local" || !value.localMapping)
    throw new HttpError(404, "LOCAL_TASK_NOT_FOUND");
  if (!["assigned", "running"].includes(value.state))
    throw new HttpError(409, "TASK_NOT_RUNNING");
  await client.executor.receive(
    {
      v: 1,
      type: "steer",
      id: `local-instruction-${createHash("sha256").update(`${runId}:${requestKey}`).digest("hex")}`,
      taskId: value.task.id,
      runId,
      revision: value.task.revision,
      text: instruction,
    },
    [value.localMapping],
    true,
    client.settings.slots,
    { progressMode: value.progressMode ?? "auto" },
  );
  return { accepted: true, source: "local" };
}
