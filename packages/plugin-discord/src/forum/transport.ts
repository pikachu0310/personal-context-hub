import { ChannelType, type Client, type ForumChannel } from "discord.js";
import {
  ForumCreateRejected,
  type ForumBinding,
  type ForumTransport,
} from "./sync.js";

export function forumTransport(
  client: Client,
  binding: ForumBinding,
  valid: () => boolean = () => true,
): ForumTransport {
  const forum = async (): Promise<ForumChannel> => {
    const channel = await client.channels.fetch(binding.issueForumChannelId);
    if (
      channel?.type !== ChannelType.GuildForum ||
      channel.guildId !== binding.guildId
    )
      throw new Error("ISSUE_FORUM_REQUIRED");
    return channel;
  };
  const thread = async (id: string) => {
    const channel = await client.channels.fetch(id);
    if (
      !channel?.isThread() ||
      channel.parentId !== binding.issueForumChannelId ||
      channel.guildId !== binding.guildId
    )
      throw new Error("FORUM_THREAD_MISMATCH");
    return channel;
  };
  return {
    async find(marker) {
      const channel = await forum();
      const active = await channel.threads.fetchActive();
      const archived = await channel.threads.fetchArchived({ limit: 100 });
      for (const candidate of [
        ...active.threads.values(),
        ...archived.threads.values(),
      ]) {
        if (
          candidate.parentId !== channel.id ||
          !candidate.name.startsWith(`${marker} · `)
        )
          continue;
        const starter = await candidate.fetchStarterMessage();
        if (
          starter &&
          starter.author.id === client.user?.id &&
          starter.content.startsWith(`${marker}\n`)
        )
          return candidate.id;
      }
      // A bounded miss is not proof creation failed. Never blindly recreate.
      return undefined;
    },
    async create(name, content) {
      let channel: ForumChannel;
      try {
        channel = await forum();
      } catch {
        throw new ForumCreateRejected("FORUM_NOT_AVAILABLE");
      }
      if (!valid()) throw new ForumCreateRejected("FORUM_CONFIG_CHANGED");
      try {
        const created = await channel.threads.create({
          name,
          message: { content, allowedMentions: { parse: [] } },
          reason: "Engine task forum synchronization",
        });
        return created.id;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status && [400, 401, 403, 404, 405, 413, 422, 429].includes(status))
          throw new ForumCreateRejected("FORUM_CREATE_REJECTED");
        throw error;
      }
    },
    async update(id, content) {
      const channel = await thread(id);
      const starter = await channel.fetchStarterMessage();
      if (!starter || starter.author.id !== client.user?.id)
        throw new Error("FORUM_STARTER_MISMATCH");
      if (!valid()) throw new Error("FORUM_CONFIG_CHANGED");
      if (channel.archived && !channel.locked) await channel.setArchived(false);
      if (!valid()) throw new Error("FORUM_CONFIG_CHANGED");
      await starter.edit({ content, allowedMentions: { parse: [] } });
    },
  };
}
