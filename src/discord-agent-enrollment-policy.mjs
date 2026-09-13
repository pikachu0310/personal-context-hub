// Enrollment grants control of the member's own Worker only, never Bot-wide
// permissions. Member data comes from Discord, not the connecting Worker.
export function canEnrollWorker(config, ownerUserId, member) {
  if (!/^\d{17,20}$/.test(ownerUserId ?? "")) return false;
  if (!config.workerAllowGuildMembers)
    return Boolean(
      config.allParticipantsOperate ||
      ownerUserId === config.allowedUserId ||
      (config.operatorUserIds ?? []).includes(ownerUserId),
    );
  if (
    !member ||
    member.userId !== ownerUserId ||
    member.guildId !== config.guildId ||
    member.bot ||
    member.pending
  )
    return false;
  const requiredRoles = config.workerEnrollmentRoleIds ?? [];
  return (
    requiredRoles.length === 0 ||
    requiredRoles.some((id) => member.roleIds?.includes(id))
  );
}

export function createWorkerOwnerAuthorizer({
  config,
  fetchMember,
  now = Date.now,
  cacheTtlMs = 30_000,
  timeoutMs = 5_000,
}) {
  const cache = new Map();
  const pending = new Map();
  return async (ownerUserId) => {
    if (!/^\d{17,20}$/.test(ownerUserId ?? "")) return false;
    if (!config.workerAllowGuildMembers)
      return canEnrollWorker(config, ownerUserId);
    const cached = cache.get(ownerUserId);
    if (cached && cached.expiresAt > now())
      return canEnrollWorker(config, ownerUserId, cached.member);
    if (!pending.has(ownerUserId)) {
      if (pending.size >= 128) return false;
      pending.set(
        ownerUserId,
        (async () => {
          let timer;
          let member;
          try {
            member = await Promise.race([
              Promise.resolve().then(() => fetchMember(ownerUserId)),
              new Promise((resolve) => {
                timer = setTimeout(() => resolve(undefined), timeoutMs);
              }),
            ]);
          } catch {
            /* Lookup failure fails closed, without stale permissions. */
          } finally {
            clearTimeout(timer);
          }
          if (cache.size >= 1024) cache.delete(cache.keys().next().value);
          cache.set(ownerUserId, { member, expiresAt: now() + cacheTtlMs });
          return member;
        })().finally(() => pending.delete(ownerUserId)),
      );
    }
    return canEnrollWorker(config, ownerUserId, await pending.get(ownerUserId));
  };
}
