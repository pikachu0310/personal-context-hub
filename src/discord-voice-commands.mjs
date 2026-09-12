import { boundText, splitDiscordText } from "./discord-voice-session.mjs";

export const IDOBATA_HELP = [
  "🪣 **井戸Bot — 話す・作る・試す**",
  "会話は共有コンテキストへ。声の依頼は「井戸Bot、〜して」。",
  "`/ido ask 質問` 即答 · `/ido context` 議事録",
  "`/ido task 依頼` 実装 · `/ido research 調査内容`",
  "`/ido benchmark 比較内容` · `/ido test 検証内容`",
  "`/ido status` 作業一覧 · `/ido stop タスクID`",
  "`/ido follow タスクID 追加指示` · `/ido new` 新しい会議",
  "`/ido apply タスクID` 確認した差分を作業場所へ反映",
  "作業・中断・新規会議は設定済みの操作担当者が使えます。",
  "作業結果は専用スレッドとこの会話へ戻ります。",
].join("\n");

export function taskControls(taskId, state) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "追加指示",
          custom_id: `ido:follow:${taskId}`,
        },
        {
          type: 2,
          style: 4,
          label: "停止",
          custom_id: `ido:stop:${taskId}`,
          disabled: !["queued", "running"].includes(state),
        },
        {
          type: 2,
          style: 1,
          label: "差分を反映",
          custom_id: `ido:apply:${taskId}`,
          disabled: state !== "completed",
        },
      ],
    },
  ];
}

export function createIdobataInteractionHandler({ config, taskQueue }) {
  return async (interaction) => {
    const match = String(interaction.customId ?? "").match(
      /^ido:(follow|instruction|stop|apply):([a-zA-Z0-9_-]+)$/,
    );
    if (!match || interaction.guildId !== config.guildId) return false;
    const reply = (content) =>
      interaction.reply({ content, flags: 64, allowedMentions: { parse: [] } });
    const userId = interaction.user?.id;
    if (
      userId !== config.allowedUserId &&
      !(config.operatorUserIds ?? []).includes(userId)
    )
      return reply("この操作は設定済みの操作担当者だけが使えます。");
    const [, action, taskId] = match;
    if (!taskQueue?.tasks.has(taskId))
      return reply("タスクが見つかりません。作業一覧を確認してください。");
    if (action === "follow")
      return interaction.showModal({
        custom_id: `ido:instruction:${taskId}`,
        title: "タスクへの追加指示",
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "instruction",
                label: "追加・修正したい内容",
                style: 2,
                required: true,
                max_length: 1800,
              },
            ],
          },
        ],
      });
    if (action === "apply") {
      await interaction.deferReply({ flags: 64 });
      try {
        return interaction.editReply(
          (await taskQueue.applyTask(taskId))
            ? "差分を元の作業場所へ反映しました。動作確認に進めます。"
            : "完了済み・未反映のタスクだけ反映できます。",
        );
      } catch {
        return interaction.editReply(
          "元の作業場所に変更があるか、差分が競合しています。添付差分を確認してください。",
        );
      }
    }
    const result = taskQueue.handleTaskMessage({
      taskId,
      userId,
      ownerUserId: userId,
      content:
        action === "stop"
          ? "停止"
          : interaction.fields.getTextInputValue("instruction"),
    });
    return reply(
      !result
        ? "操作できませんでした。作業一覧を確認してください。"
        : result.type === "full"
          ? "追加指示の待機枠がいっぱいです。"
          : action === "stop"
            ? "タスクを停止しました。"
            : "追加指示を受け付けました。同じ作業に続けて反映します。",
    );
  };
}

export function createIdobataMessageHandler({
  config,
  session,
  taskQueue,
  resetMeeting = async () => undefined,
}) {
  const seen = new Set();
  return async (message) => {
    if (message.author?.bot || message.guildId !== config.guildId) return false;
    const authorized =
      message.author?.id === config.allowedUserId ||
      (config.operatorUserIds ?? []).includes(message.author?.id);
    if (message.id && seen.has(message.id)) return false;
    if (message.id) {
      seen.add(message.id);
      if (seen.size > 1000) seen.delete(seen.values().next().value);
    }
    if (message.channelId !== config.textChannelId) {
      if (!authorized) return false;
      return (
        taskQueue?.handleThreadMessage({
          threadId: message.channelId,
          userId: message.author.id,
          ownerUserId: message.author.id,
          content: message.content,
        }) ?? false
      );
    }
    const content = String(message.content ?? "").trim();
    const match = content.match(/^[!/]ido(?:\s+(\w+))?(?:\s+([\s\S]*))?$/i);
    const reply = (text) =>
      message.channel.send({
        content: boundText(text, 1950),
        allowedMentions: { parse: [] },
        flags: config.silentMessages === false ? undefined : 4096,
      });
    if (!match) {
      if (content)
        await session.addText?.(content, {
          userId: message.author.id,
          speakerName: message.member?.displayName ?? message.author.username,
        });
      return Boolean(content);
    }
    const command = (match[1] ?? "help").toLowerCase();
    const argument = (match[2] ?? "").trim();
    if (command === "help") return reply(IDOBATA_HELP);
    if (command === "status") {
      const tasks = taskQueue?.list() ?? [];
      return reply(
        tasks.length
          ? tasks
              .map(
                (task) =>
                  `\`${task.id}\` ${task.state} · ${task.title}${task.threadId ? ` <#${task.threadId}>` : ""}`,
              )
              .join("\n")
          : "まだ作業はありません。`/ido task 依頼` で開始できます。",
      );
    }
    if (command === "context") {
      for (const chunk of splitDiscordText(
        session.getContextSnapshot?.() ??
          session.minutes ??
          "会話の前提・決定事項をこれから記録します。",
      ))
        await reply(chunk);
      return true;
    }
    if (command === "ask") {
      if (!argument) return reply("`/ido ask 質問内容` と入力してください。");
      // Explicit questions are context, not authorization for background work.
      await session.addText?.(argument, {
        userId: message.author.id,
        speakerName: message.member?.displayName ?? message.author.username,
        taskEligible: false,
        requestReply: true,
      });
      return true;
    }
    if (!authorized)
      return reply(
        "作業の起動・操作は設定済みの操作担当者に依頼してください。会話と質問には参加できます。",
      );
    if (command === "new") {
      if (!(await session.newMeeting?.()))
        return reply(
          "音声認識・観測中です。処理が落ち着いてから `/ido new` を実行してください。",
        );
      await resetMeeting();
      return reply(
        "新しい会議を開始しました。以前の会話ログとタスクの成果は保存されています。",
      );
    }
    if (!taskQueue)
      return reply(
        "作業モードは未設定です。管理者が POWER_MODE を有効にしてください。",
      );
    if (command === "apply") {
      try {
        return reply(
          (await taskQueue.applyTask(argument))
            ? "✅ 差分を元の作業場所へ反映しました。起動・動作確認に進めます。"
            : "反映できる完了タスクを指定してください。",
        );
      } catch {
        return reply(
          "開始後に元の作業場所が変わったか、差分が競合しています。自動反映を止めました。添付差分を確認してください。",
        );
      }
    }
    if (["task", "research", "benchmark", "test"].includes(command)) {
      if (!argument) return reply("コマンドの後に依頼内容を入れてください。");
      const accepted = taskQueue.enqueue({
        title: argument.slice(0, 100),
        request: argument,
        context:
          session.getContextSnapshot?.() ??
          session.minutes + "\n" + JSON.stringify(session.results ?? []),
        meetingId: session.meetingId,
        kind: command === "task" ? "implementation" : command,
        complexity: "routine",
      });
      return reply(
        accepted
          ? "🧰 作業を受け付けました。専用スレッドへ進捗と結果を返します。"
          : "作業枠がいっぱいです。`/ido status` で確認できます。",
      );
    }
    if (["stop", "follow"].includes(command)) {
      const [taskId, ...words] = argument.split(/\s+/);
      if (!taskId || (command === "follow" && !words.length))
        return reply(
          "タスクIDを指定してください。追加指示はIDの後に続けます。",
        );
      const action = taskQueue.handleTaskMessage({
        taskId,
        userId: message.author.id,
        ownerUserId: message.author.id,
        content: command === "stop" ? "停止" : words.join(" "),
      });
      if (action?.type === "full")
        return reply(
          "追加指示・作業枠がいっぱいです。少し待ってから再送してください。",
        );
      return reply(
        action
          ? command === "stop"
            ? "⏹️ 指定タスクを停止しました。"
            : "➕ 指定タスクへ追加指示を渡しました。"
          : "そのタスクを操作できません。`/ido status` と対象スレッドを確認してください。",
      );
    }
    return reply(IDOBATA_HELP);
  };
}
