import {
  ChannelType,
  MessageFlags,
  ApplicationCommandOptionType as Option,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
  type VoiceChannel,
} from "discord.js";

export async function registerVoiceCommands(guild: Guild) {
  // Upsert only this command; preserve unrelated commands on the application.
  await guild.commands.create({
    name: "project",
    description: "会話するプロジェクトを選択・確認",
    options: [
      {
        name: "name",
        description: "既存プロジェクトを候補から選択",
        type: Option.String,
        autocomplete: true,
      },
    ],
  });
  await guild.commands.create({
    name: "join",
    description: "自分がいる音声チャンネルにIDOを呼ぶ",
  });
  await guild.commands.create({
    name: "leave",
    description: "IDOを音声チャンネルから退出させる",
  });
  await guild.commands.create({
    name: "ido",
    description: "IDOの会話とタスクを操作する",
    options: [
      ...[
        ["join", "この通話に参加"],
        ["leave", "この通話から退出"],
        ["quiet", "現在の読み上げを停止"],
        ["context", "議事録全文を表示"],
        ["connect", "IDO AgentのインストールとPC接続の案内"],
      ].map(([name, description]) => ({
        name,
        description,
        type: Option.Subcommand as const,
      })),
      {
        name: "mode",
        description: "会話方式を切り替える",
        type: Option.Subcommand,
        options: [
          {
            name: "value",
            description: "会話方式",
            type: Option.String,
            required: true,
            choices: [
              { name: "テキストとSTT/TTS", value: "text-speech" },
              { name: "GPT-Liveと話者別STT", value: "live" },
            ],
          },
        ],
      },
      {
        name: "ask",
        description: "IDOに質問する",
        type: Option.Subcommand,
        options: [
          {
            name: "text",
            description: "質問",
            type: Option.String,
            required: true,
            max_length: 4000,
          },
        ],
      },
      {
        name: "stop",
        description: "既存タスクを停止する",
        type: Option.Subcommand,
        options: [
          {
            name: "task",
            description: "タスクID（候補が1件なら省略可）",
            type: Option.String,
            max_length: 100,
          },
        ],
      },
      {
        name: "steer",
        description: "既存タスクに追加指示",
        type: Option.Subcommand,
        options: [
          {
            name: "text",
            description: "追加指示",
            type: Option.String,
            required: true,
            max_length: 4000,
          },
          {
            name: "task",
            description: "タスクID（候補が1件なら省略可）",
            type: Option.String,
            max_length: 100,
          },
        ],
      },
    ],
  });
}
export interface MeetingControls {
  connect?(): Promise<string>;
  allowed(userId: string): boolean;
  textChannelId: string;
  quiet(userId: string): void;
  request(
    event: Record<string, unknown>,
  ): Promise<{ content: string; file?: string }>;
}
export function voiceCommandHandler(
  guildId: string,
  join: (channel: VoiceChannel) => Promise<void>,
  leave: () => void,
  currentChannel: () => string | undefined,
  controls?: MeetingControls,
) {
  let busy = false;
  return async (interaction: ChatInputCommandInteraction) => {
    const command =
      interaction.commandName === "ido"
        ? interaction.options.getSubcommand()
        : interaction.commandName;
    if (
      ![
        "join",
        "leave",
        "quiet",
        "context",
        "ask",
        "stop",
        "steer",
        "mode",
        "connect",
      ].includes(command)
    )
      return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = (content: string) =>
      interaction.editReply({ content, allowedMentions: { parse: [] } });
    if (interaction.guildId !== guildId || !interaction.guild) {
      await reply("このBotに設定されたサーバーで実行してください。");
      return;
    }
    if (controls && !controls.allowed(interaction.user.id)) {
      await reply(
        "このユーザーは受付対象ではありません。管理画面の許可ユーザー設定を確認してください。",
      );
      return;
    }
    if (!["join", "leave"].includes(command)) {
      if (!controls) return;
      if (command === "connect") {
        try {
          await reply((await controls.connect?.()) ?? "接続案内は準備中です。");
        } catch {
          await reply(
            "接続案内を取得できません。Engineの設定を確認してください。",
          );
        }
        return;
      }
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const inVoice =
        Boolean(currentChannel()) &&
        member.voice.channelId === currentChannel();
      if (!inVoice && interaction.channelId !== controls.textChannelId) {
        await reply(
          "Botと同じ通話、または設定されたテキストチャンネルから実行してください。",
        );
        return;
      }
      if (command === "quiet") {
        controls.quiet(interaction.user.id);
        await reply("読み上げを停止しました。文字起こしとタスクは継続します。");
        return;
      }
      try {
        const result = await controls.request({
          command,
          interaction: true,
          eventId: interaction.id,
          userId: interaction.user.id,
          guildId,
          channelId: inVoice ? currentChannel() : interaction.channelId,
          source: inVoice ? "voice-command" : "text",
          text: interaction.options.getString("text") ?? "",
          taskId: interaction.options.getString("task") ?? undefined,
          conversationMode:
            command === "mode"
              ? interaction.options.getString("value")
              : undefined,
        });
        await interaction.editReply({
          content: result.content.slice(0, 1900),
          allowedMentions: { parse: [] },
          ...(result.file
            ? {
                files: [
                  { attachment: Buffer.from(result.file), name: "minutes.txt" },
                ],
              }
            : {}),
        });
      } catch {
        await reply(
          "処理に失敗しました。Engineの接続・会議設定を確認してください。",
        );
      }
      return;
    }
    if (busy) {
      await reply("通話への接続処理中です。少し待ってからお試しください。");
      return;
    }
    busy = true;
    try {
      if (command === "leave" && !currentChannel()) {
        await reply("現在、音声チャンネルには参加していません。");
        return;
      }
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const channel = member.voice.channel;
      if (command === "leave") {
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
