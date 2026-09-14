// Discord identities come from the Bot SDK; invitations and task text cannot
// select another person's Worker or grant Bot-wide operator privileges.
export function isTaskOperator(config, userId) {
  return (
    Boolean(userId) &&
    Boolean(
      config.allParticipantsOperate ||
      userId === config.allowedUserId ||
      config.operatorUserIds?.includes(userId),
    )
  );
}

export async function participantTaskAssignment(config, gateway, userId) {
  if (!gateway || !userId) return undefined;
  if (!isTaskOperator(config, userId) && !config.workerAllowGuildMembers)
    return undefined;
  if (!(await gateway.authorizeOwner?.(userId))) return undefined;
  const workers = gateway.statusForOwner(userId);
  const worker = workers.find((entry) => entry.ownerUserId === userId);
  if (!worker) return undefined;
  return {
    requestedByUserId: userId,
    workerOwnerUserId: userId,
    assignedAgentId: worker.agentId,
    assignedAgentName: worker.name,
    assignedAgentTransport: "remote",
    assignedAgentOwnerUserId: userId,
  };
}

export async function canControlDiscordTask(
  config,
  gateway,
  userId,
  task,
  action,
) {
  if (!task || !userId) return false;
  if (isTaskOperator(config, userId)) return true;
  if (task.workerOwnerUserId !== userId || task.requestedByUserId !== userId)
    return false;
  // Stopping one's own task remains possible after enrollment/role revocation.
  if (action === "stop") return true;
  return (
    ["follow", "instruction"].includes(action) &&
    Boolean(
      config.workerAllowGuildMembers &&
      (await gateway?.authorizeOwner?.(userId)),
    )
  );
}
