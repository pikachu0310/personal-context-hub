export function participantGroups<
  T extends { id: string; identityId?: string },
>(participants: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const person of participants) {
    const key = person.identityId ?? person.id;
    const group = groups.get(key) ?? [];
    group.push(person);
    groups.set(key, group);
  }
  return [...groups.values()];
}
// Never use this presentation helper for task controls or project permissions.
export function isSelf(
  person: { id: string; identityId?: string },
  self: { deviceId?: string; identityId?: string },
) {
  return (
    person.id === self.deviceId ||
    Boolean(person.identityId && person.identityId === self.identityId)
  );
}

export function previousRegistration(
  task: { clientId?: string; clientIdentityId?: string },
  self: { deviceId?: string; identityId?: string },
) {
  return Boolean(
    task.clientId &&
    task.clientId !== self.deviceId &&
    task.clientIdentityId &&
    task.clientIdentityId === self.identityId,
  );
}
