import type { Task } from "@ido/common/contracts/protocol";
import { normalizeExecutionPolicy } from "@ido/common/contracts/work";
import type { Repository } from "../../ports/repository.js";
import type { WorkPort } from "../../ports/work.js";
import { Tasks } from "./service.js";

export function createWorkPort({
  repository,
  tasks = new Tasks(repository),
  onChange = () => {},
}: {
  repository: Repository;
  tasks?: Tasks;
  onChange?: () => void;
}): WorkPort {
  let deferrals = 0;
  let dirty = false;
  const changed = () => {
    if (deferrals) dirty = true;
    else onChange();
  };
  return {
    deferDispatch() {
      deferrals++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--deferrals === 0 && dirty) {
          dirty = false;
          onChange();
        }
      };
    },
    submit(request) {
      const actor = repository.conversationAuthor(request.authorId);
      if (!actor || actor.role === "viewer")
        throw new Error("PERMISSION_DENIED");
      const task = tasks.createTask({
        sourcePluginId: request.sourcePluginId,
        projectId: request.projectId,
        meetingId: request.meetingId,
        authorId: request.authorId,
        requestId: request.requestKey,
        text: request.request,
        network: request.network === true,
        title: request.title,
        kind: request.kind,
        createdByBot: true,
        trigger: request.trigger,
        priority: request.priority,
        sourceIds: structuredClone(request.sourceIds),
        sourceStatements: structuredClone(request.sourceStatements),
        sourceSequences: structuredClone(request.sourceSequences),
        executionPolicy: normalizeExecutionPolicy(request.executionPolicy),
      });
      changed();
      return structuredClone(task);
    },
    prioritize(updates) {
      const applied = repository.transaction(() => {
        const ids: string[] = [];
        for (const update of updates) {
          const task = repository.get<Task>("task", update.taskId);
          if (
            !task ||
            task.projectId !== update.projectId ||
            repository.get("project-lock", task.projectId) ||
            task.revision !== update.expectedRevision ||
            (task.controlVersion ?? 0) !== update.expectedControlVersion ||
            (task.priority?.version ?? 0) !== update.expectedVersion
          )
            continue;
          task.priority = structuredClone(update.priority);
          if (
            update.priority.evaluation.intent === "requested" &&
            update.priority.evaluation.certainty === 4
          )
            task.trigger = "requested";
          task.updatedAt = Date.now();
          repository.put("task", task.id, task);
          ids.push(task.id);
        }
        return ids;
      });
      if (applied.length) changed();
      return applied;
    },
    control(input) {
      const actor = repository.conversationAuthor(input.authorId);
      if (!actor || actor.role === "viewer")
        throw new Error("PERMISSION_DENIED");
      const result = tasks.control(
        input.taskId,
        input.authorId,
        input.type === "instruction" ? "steer" : input.type,
        input.instruction,
        {
          sourcePluginId: input.sourcePluginId,
          requestKey: input.requestKey,
          expectedControlVersion: input.expectedControlVersion,
          instructionResolution: input.instructionResolution,
          continuation: input.continuation,
        },
      );
      changed();
      return structuredClone(result);
    },
    list: (meetingId) =>
      structuredClone(
        repository
          .list<Task>("task")
          .filter((task) => !meetingId || task.meetingId === meetingId),
      ),
    getReceipt({ requestKey, authorId, projectId }) {
      const id = repository.requestTask(
        JSON.stringify([authorId, projectId, requestKey]),
      );
      return id ? structuredClone(repository.get<Task>("task", id)) : undefined;
    },
    getResult(taskId) {
      const task = repository.get<Task>("task", taskId);
      if (!task || (task.result === undefined && task.state !== "failed"))
        return undefined;
      const failed = task.state === "failed";
      const resultSpecRevision =
        task.resultSpecRevision ??
        (failed ? (task.specRevision ?? 1) : undefined);
      return structuredClone({
        id: task.id,
        meetingId: task.meetingId,
        projectId: task.projectId,
        title: task.title ?? task.text.slice(0, 120),
        result: failed
          ? `タスクは失敗しました。${task.progress ?? "実行が完了する前に停止しました。"}${task.result ? `\n未完了の出力:\n${task.result}` : ""}`
          : task.result!,
        state: task.state,
        runId: task.runId,
        runRevision: task.revision,
        specRevision: task.specRevision ?? 1,
        resultSpecRevision,
        superseded:
          (!failed && resultSpecRevision !== (task.specRevision ?? 1)) ||
          Object.values(task.controlReceipts ?? {}).some(
            (receipt) => receipt.delivery === "uncertain",
          ),
        sourceIds: task.sourceIds ?? [],
        sourceStatements: task.sourceStatements ?? [],
        sourceSequences: task.sourceSequences ?? [],
      });
    },
  };
}
