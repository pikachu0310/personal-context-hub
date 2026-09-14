import type { Task } from "../../../../common/src/contracts/protocol.js";
import { normalizeExecutionPolicy } from "../../../../common/src/contracts/work.js";
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
  return {
    submit(request) {
      const actor = repository.conversationAuthor(request.authorId);
      if (!actor || actor.role === "viewer")
        throw new Error("PERMISSION_DENIED");
      const task = tasks.createTask({
        projectId: request.projectId,
        meetingId: request.meetingId,
        authorId: request.authorId,
        requestId: request.requestKey,
        text: request.request,
        network: request.network === true,
        title: request.title,
        kind: request.kind,
        sourceIds: structuredClone(request.sourceIds),
        sourceStatements: structuredClone(request.sourceStatements),
        sourceSequences: structuredClone(request.sourceSequences),
        executionPolicy: normalizeExecutionPolicy(request.executionPolicy),
      });
      onChange();
      return structuredClone(task);
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
          requestKey: input.requestKey,
          expectedControlVersion: input.expectedControlVersion,
          instructionResolution: input.instructionResolution,
        },
      );
      onChange();
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
