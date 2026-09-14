export interface DiscordPolicy {
  userPolicy?: string;
  allowedUserIds?: string;
}

export function discordUserAllowed(config: DiscordPolicy, userId: string) {
  if (!/^\d{1,24}$/.test(userId)) return false;
  if (config.userPolicy === undefined || config.userPolicy === "all")
    return true;
  return (
    config.userPolicy === "allowlist" &&
    (config.allowedUserIds ?? "").split(/[\s,]+/).includes(userId)
  );
}

export function normalizeDiscordPolicy(config: DiscordPolicy) {
  const userPolicy = config.userPolicy ?? "all";
  if (!["all", "allowlist"].includes(userPolicy))
    throw new Error("INVALID_DISCORD_POLICY");
  if (
    config.allowedUserIds !== undefined &&
    typeof config.allowedUserIds !== "string"
  )
    throw new Error("INVALID_DISCORD_USER_IDS");
  const ids = [
    ...new Set((config.allowedUserIds ?? "").split(/[\s,]+/).filter(Boolean)),
  ];
  if (ids.length > 100 || ids.some((id) => !/^\d{1,24}$/.test(id)))
    throw new Error("INVALID_DISCORD_USER_IDS");
  return { userPolicy, allowedUserIds: ids.join("\n") };
}
