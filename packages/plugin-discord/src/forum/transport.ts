import {
  ChannelType,
  type Client,
  type ForumChannel,
  type TextChannel,
} from "discord.js";
import { createHash } from "node:crypto";
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
  const forum = async (): Promise<ForumChannel | TextChannel> => {
    const channel = await client.channels.fetch(binding.issueForumChannelId);
    if (
      !channel ||
      (channel.type !== ChannelType.GuildForum &&
        channel.type !== ChannelType.GuildText) ||
      channel.guildId !== binding.guildId
    )
      throw new Error("ISSUE_FORUM_REQUIRED");
    return channel as ForumChannel | TextChannel;
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
      let channel: ForumChannel | TextChannel;
      try {
        channel = await forum();
      } catch {
        throw new ForumCreateRejected("FORUM_NOT_AVAILABLE");
      }
      if (!valid()) throw new ForumCreateRejected("FORUM_CONFIG_CHANGED");
      let published = false;
      try {
        if (channel.type === ChannelType.GuildText) {
          const message = await channel.send({
            content,
            allowedMentions: { parse: [] },
            nonce: createHash("sha256")
              .update(content.split("\n", 1)[0])
              .digest("hex")
              .slice(0, 24),
            enforceNonce: true,
          });
          published = true;
          if (!valid()) throw new Error("FORUM_CONFIG_CHANGED");
          const created =
            message.thread ??
            (await message.startThread({
              name,
              reason: "Engine task progress synchronization",
            }));
          return created.id;
        }
        const created = await channel.threads.create({
          name,
          message: { content, allowedMentions: { parse: [] } },
          reason: "Engine task forum synchronization",
        });
        return created.id;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (
          !published &&
          status &&
          [400, 401, 403, 404, 405, 413, 422, 429].includes(status)
        )
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
