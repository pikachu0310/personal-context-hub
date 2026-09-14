export function createDistributedTaskRunner({
  localRunner,
  workerGateway,
  agentTeam,
  listTasks = () => [],
}) {
  return async (task, options) => {
    const excluded = [];
    while (workerGateway?.hasAgent(task.assignedAgentId)) {
      try {
        return await workerGateway.runTask(task, options);
      } catch (error) {
        if (
          ![
            "WORKER_OFFLINE",
            "WORKER_POLICY_UNSUPPORTED",
            "WORKER_DISCONNECTED",
            "WORKER_LEASE_EXPIRED",
          ].includes(error?.code)
        )
          throw error;
        excluded.push(task.assignedAgentId);
        agentTeam.finish(task.agentExecutionLease);
        const replacement = agentTeam.reassign(task, listTasks(), excluded);
        if (!replacement) throw error;
        const nextLease = { assignedAgentId: replacement.id };
        if (!agentTeam.start(nextLease)) throw error;
        task.agentExecutionLease = nextLease;
        task.reassignments ??= [];
        task.reassignments.push({
          from: excluded.at(-1),
          to: replacement.id,
          reason: error.code,
          at: Date.now(),
        });
        await task.checkpoint?.();
        await options?.onProgress?.(
          error.code === "WORKER_POLICY_UNSUPPORTED"
            ? `🔄 Workerが実行制約に未対応のため ${replacement.name} へ再割り当てました。`
            : `🔄 Worker切断のため ${replacement.name} へ安全に再割り当てました。`,
        );
      }
    }
    return localRunner(task, options);
  };
}
