import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
  type VoiceChannel,
} from "discord.js";

export async function registerVoiceCommands(guild: Guild) {
  // Upsert only this command; preserve unrelated commands on the application.
  await guild.commands.create({
    name: "join",
    description: "自分がいる音声チャンネルにIDOを呼ぶ",
  });
  await guild.commands.create({
    name: "leave",
    description: "IDOを音声チャンネルから退出させる",
  });
}
export function voiceCommandHandler(
  guildId: string,
  join: (channel: VoiceChannel) => Promise<void>,
  leave: () => void,
  currentChannel: () => string | undefined,
) {
  let busy = false;
  return async (interaction: ChatInputCommandInteraction) => {
    if (!["join", "leave"].includes(interaction.commandName)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = (content: string) =>
      interaction.editReply({ content, allowedMentions: { parse: [] } });
    if (interaction.guildId !== guildId || !interaction.guild) {
      await reply("このBotに設定されたサーバーで実行してください。");
      return;
    }
    if (busy) {
      await reply("通話への接続処理中です。少し待ってからお試しください。");
      return;
    }
    busy = true;
    try {
      if (interaction.commandName === "leave" && !currentChannel()) {
        await reply("現在、音声チャンネルには参加していません。");
        return;
      }
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const channel = member.voice.channel;
      if (interaction.commandName === "leave") {
        if (channel?.id !== currentChannel()) {
          await reply(
            "Botと同じ音声チャンネルに参加してから /leave を実行してください。",
          );
          return;
        }
        leave();
        await reply(
          "音声チャンネルから退出し、音声の受信・再生を停止しました。",
        );
        return;
      }
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await reply(
          "先に音声チャンネルに参加してから /join を実行してください。",
        );
        return;
      }
      const me =
        interaction.guild.members.me ??
        (await interaction.guild.members.fetchMe());
      if (
        !channel
          .permissionsFor(me)
          ?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
          ])
      ) {
        await reply(
          "Botにこの通話の「チャンネルを見る」「接続」「発言」権限を許可してください。",
        );
        return;
      }
      await join(channel);
      await reply(
        "音声チャンネルに参加しました。発話を文字起こし・議事録に利用します。参加者に案内してください。",
      );
    } catch {
      await reply(
        "通話の操作に失敗しました。Botの権限・チャンネルの人数制限・音声接続を確認し、再度コマンドを実行してください。",
      );
    } finally {
      busy = false;
    }
  };
}
