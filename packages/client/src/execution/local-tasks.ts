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
    sharing: Object.values(runs).some((value) => value.discordShare)
      ? "per-task"
      : "not-connected",
    tasks: Object.values(runs)
      .filter((value) => value.origin === "local")
      .map((value) => {
        const summary = {
          taskId: value.task.id,
          runId: value.task.runId,
          revision: value.task.revision,
          agent: value.agent ?? "codex",
          model: value.model,
          reasoningEffort: value.reasoningEffort,
          state: value.state,
          phase: value.phase,
          progressMode: value.progressMode,
          discordSharing: value.discordShare?.status ?? "disabled",
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
      const reasoningEffort = input.reasoningEffort || undefined;
      if (
        reasoningEffort !== undefined &&
        (typeof reasoningEffort !== "string" ||
          !available.models
            .find((value) => value.id === model)
            ?.supportedEfforts?.includes(reasoningEffort))
      )
        throw new HttpError(400, "EFFORT_UNAVAILABLE");
      if (
        agent === "claude" &&
        input.accessMode === undefined &&
        input.claudePermissionsAcknowledged !== true
      )
        throw new HttpError(400, "CLAUDE_PERMISSIONS_REQUIRED");
      const title = text(input.title || instruction.slice(0, 100), 200);
      if (!["auto", "manual"].includes(String(input.mode)))
        throw new HttpError(400, "INVALID_PROGRESS_MODE");
      if (
        input.accessMode !== undefined &&
        !["full", "approval"].includes(String(input.accessMode))
      )
        throw new HttpError(400, "INVALID_ACCESS_MODE");
      const accessMode =
        input.accessMode === undefined
          ? undefined
          : input.mode === "auto"
            ? "full"
            : (input.accessMode as "full" | "approval");
      if (
        !accessMode &&
        !["workspace-write", "read-only"].includes(String(input.sandboxMode))
      )
        throw new HttpError(400, "INVALID_SANDBOX_MODE");
      const directory = await realpath(text(input.directory, 4000));
      try {
        await run("git", ["-C", directory, "rev-parse", "--show-toplevel"]);
        await run("git", ["-C", directory, "rev-parse", "--verify", "HEAD"]);
      } catch {
        throw new HttpError(400, "COMMITTED_REPOSITORY_REQUIRED");
      }
      const share = input.shareDiscord === true;
      const shareProject = share ? id(input.shareProjectId) : undefined;
      if (
        share &&
        (!client.settings.engineUrl ||
          !client.settings.deviceId ||
          !client.settings.projects.some((p) => p.id === shareProject))
      )
        throw new HttpError(409, "SHARE_PROJECT_REQUIRED");
      const projectId =
        shareProject ??
        `local-${createHash("sha256").update(directory).digest("hex").slice(0, 24)}`;
      const mapping = {
        projectId,
        directory,
        network: accessMode ? true : input.network === true,
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
          sandboxMode: accessMode
            ? undefined
            : (input.sandboxMode as "workspace-write" | "read-only"),
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
        {
          progressMode: input.mode as "auto" | "manual",
          agent,
          model,
          reasoningEffort,
          accessMode,
          discordShare: share
            ? {
                engineUrl: client.settings.engineUrl!,
                deviceId: client.settings.deviceId!,
                projectId,
                sequence: 0,
                status: "pending",
              }
            : undefined,
        },
      );
      if (!client.executor.runs[runId])
        throw new HttpError(409, "LOCAL_SLOTS_FULL");
      void client.syncLocalShares();
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

export async function continueLocalTask(
  client: Client,
  runId: string,
  requestKey: string,
  instruction: string,
  revision: number,
) {
  const commandId = `local-continue-${createHash("sha256").update(`${runId}:${requestKey}`).digest("hex")}`;
  const operation = client.processing
    .catch(() => {})
    .then(async () => {
      const value = client.executor.runs[runId];
      if (!value || value.origin !== "local" || !value.localMapping)
        throw new HttpError(404, "LOCAL_TASK_NOT_FOUND");
      if (client.executor.commands.includes(commandId))
        return { accepted: true, source: "local" };
      if (value.task.revision !== revision)
        throw new HttpError(409, "TASK_CONTROL_SUPERSEDED");
      if (
        !["completed", "failed", "cancelled", "interrupted"].includes(
          value.state,
        )
      )
        throw new HttpError(409, "TASK_STILL_ACTIVE");
      if (
        value.instructions?.some((item) =>
          ["sending", "uncertain"].includes(item.delivery),
        )
      )
        throw new HttpError(409, "INSTRUCTION_DELIVERY_UNCERTAIN");
      await client.executor.running.get(runId);
      const task = structuredClone(value.task);
      task.history.push({
        revision: task.revision,
        text: task.text,
        result: value.result,
        specRevision: task.specRevision,
        resultSpecRevision: task.resultSpecRevision,
      });
      task.revision++;
      task.specRevision = (task.specRevision ?? 1) + 1;
      task.text += `\n\n追加依頼:\n${instruction}`;
      task.state = "assigned";
      task.result = undefined;
      task.resultSpecRevision = undefined;
      task.updatedAt = Date.now();
      await client.executor.receive(
        {
          v: 1,
          type: "retry",
          id: commandId,
          taskId: task.id,
          runId,
          task,
          continuation: instruction,
        },
        [value.localMapping],
        true,
        client.settings.slots,
        {
          progressMode: value.progressMode ?? "auto",
          agent: value.agent,
          model: value.model,
          reasoningEffort: value.reasoningEffort,
        },
      );
      if (client.executor.runs[runId].task.revision !== task.revision)
        throw new HttpError(409, "LOCAL_SLOTS_FULL");
      return { accepted: true, source: "local" };
    });
  client.processing = operation;
  return operation;
}
