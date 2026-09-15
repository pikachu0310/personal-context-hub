import {
  ChannelType,
  PermissionFlagsBits as P,
  PermissionsBitField,
} from "discord.js";
export async function inspectSetup(
  config: Record<string, string>,
  request: typeof fetch = fetch,
) {
  if (!config.botToken) throw new Error("DISCORD_TOKEN_REQUIRED");
  if (!/^\d+$/.test(config.guildId ?? ""))
    throw new Error("DISCORD_GUILD_REQUIRED");
  const get = async (path: string, error: string) => {
    const response = await request(`https://discord.com/api/v10${path}`, {
      headers: { Authorization: `Bot ${config.botToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 401 ? "DISCORD_TOKEN_INVALID" : error,
      );
    return response.json();
  };
  const app = await get("/oauth2/applications/@me", "DISCORD_TOKEN_INVALID");
  const me = await get("/users/@me", "DISCORD_TOKEN_INVALID");
  const guild = await get(
    `/guilds/${config.guildId}`,
    "DISCORD_GUILD_ACCESS_REQUIRED",
  );
  const member = await get(
    `/guilds/${config.guildId}/members/${me.id}`,
    "DISCORD_GUILD_ACCESS_REQUIRED",
  );
  const channels = (await get(
    `/guilds/${config.guildId}/channels`,
    "DISCORD_GUILD_ACCESS_REQUIRED",
  )) as Array<{
    id: string;
    name: string;
    type: number;
    permission_overwrites: Array<{
      id: string;
      type: number;
      allow: string;
      deny: string;
    }>;
  }>;
  const roles = guild.roles as Array<{ id: string; permissions: string }>;
  const base = roles
    .filter((r) => r.id === guild.id || member.roles.includes(r.id))
    .reduce((value, r) => value | BigInt(r.permissions), 0n);
  const eligible = channels.filter((channel) => {
    if (
      ![
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.GuildForum,
      ].includes(channel.type)
    )
      return false;
    let permissions = base;
    if (me.id !== guild.owner_id && !(base & P.Administrator)) {
      const apply = (items: typeof channel.permission_overwrites) => {
        const deny = items.reduce((v, o) => v | BigInt(o.deny), 0n);
        const allow = items.reduce((v, o) => v | BigInt(o.allow), 0n);
        permissions = (permissions & ~deny) | allow;
      };
      apply(channel.permission_overwrites.filter((o) => o.id === guild.id));
      apply(
        channel.permission_overwrites.filter(
          (o) => o.type === 0 && member.roles.includes(o.id),
        ),
      );
      apply(
        channel.permission_overwrites.filter(
          (o) => o.type === 1 && o.id === me.id,
        ),
      );
    } else return true;
    return new PermissionsBitField(permissions).has([
      P.ViewChannel,
      P.SendMessages,
      P.ReadMessageHistory,
      P.AttachFiles,
      ...(channel.type === ChannelType.GuildForum
        ? [P.SendMessagesInThreads]
        : channel.id === config.issueForumChannelId
          ? [P.CreatePublicThreads, P.SendMessagesInThreads]
          : []),
    ]);
  });
  const available = eligible
    .filter((channel) => channel.type !== ChannelType.GuildForum)
    .map(({ id, name }) => ({ id, name }));
  const forums = eligible
    .filter((channel) => channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildText)
    .map(({ id, name }) => ({ id, name }));
  if (
    config.issueForumChannelId &&
    !forums.some((channel) => channel.id === config.issueForumChannelId)
  )
    throw new Error("DISCORD_FORUM_PERMISSION_REQUIRED");
  if (
    config.textChannelId &&
    !available.some((c) => c.id === config.textChannelId)
  )
    throw new Error("DISCORD_CHANNEL_PERMISSION_REQUIRED");
  return { appId: String(app.id), channels: available };
}
