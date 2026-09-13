import { boundText } from "../../engine/shared.mjs";
import {
  encodeAgentInvitation,
  agentGuideComponents,
} from "../../discord-agent-onboarding.mjs";
import { splitDiscordText, escapeDiscordMarkdown } from "./presentation.mjs";
import { requestedVoiceModel } from "../../engine/model-policy.mjs";

export const IDOBATA_APPLICATION_COMMAND = {
  name: "ido",
  description: "井戸Botの通話・議事録・作業を操作",
  options: [
    {
      type: 2,
      name: "agent",
      description: "自分のCodex Workerを接続・切断",
      options: [
        {
          type: 1,
          name: "connect",
          description: "この端末用の接続コードを発行",
        },
        { type: 1, name: "disconnect", description: "自分のWorker登録を失効" },
        { type: 1, name: "status", description: "自分のWorker接続状態" },
      ],
    },
    ...[
      ["join", "設定された通話へ接続"],
      ["leave", "通話から退出"],
      ["status", "通話状態・作業一覧", false],
      ["agents", "接続中のCodexエージェント一覧"],
      ["context", "現在の議事録全文"],
      ["ask", "井戸Botへ質問", true],
      ["quiet", "読み上げを停止"],
      ["live", "GPT-Liveの30分比較セッションをon/off", true],
      ["help", "コマンド一覧"],
      ["task", "実装を依頼", true],
      ["research", "調査を依頼", true],
      ["benchmark", "比較を依頼", true],
      ["test", "検証を依頼", true],
      ["stop", "タスクIDを指定して停止", true],
      ["result", "タスクIDを指定して結果表示", true],
      ["follow", "タスクIDと追加指示を指定", true],
      ["apply", "タスクIDと実行版を指定して反映", true],
      ["new", "新しい会議"],
    ].map(([name, description, required]) => ({
      type: 1,
      name,
      description,
      ...(required !== undefined
        ? {
            options: [
              {
                type: 3,
                name: "input",
                description: "内容・ID・ページ番号",
                required,
                max_length: 1800,
              },
              ...(["task", "research", "benchmark", "test"].includes(name)
                ? [
                    {
                      type: 3,
                      name: "model",
                      description:
                        "通常はSol low。Astraは指定した作業だけで使用",
                      required: false,
                      choices: [
                        { name: "Sol low（通常）", value: "sol" },
                        { name: "Astra high（この作業のみ）", value: "astra" },
                      ],
                    },
                  ]
                : []),
            ],
          }
        : {}),
    })),
  ],
};

export function createIdobataSlashHandler({ config, handleMessage }) {
  const commandChannelIds = new Set(
    [
      config.textChannelId,
      config.agentCoordinationChannelId,
      ...(config.codexAgents ?? []).map(({ channelId }) => channelId),
    ].filter(Boolean),
  );
  return async (interaction) => {
    if (
      !interaction.isChatInputCommand?.() ||
      interaction.commandName !== "ido" ||
      interaction.guildId !== config.guildId
    )
      return false;
    if (!commandChannelIds.has(interaction.channelId)) {
      await interaction.reply({
        content: `操作は <#${config.agentCoordinationChannelId ?? config.textChannelId}> で使ってください。`,
        flags: 64,
        allowedMentions: { parse: [] },
      });
      return true;
    }
    await interaction.deferReply({ flags: 64 });
    let replied = false;
    const send = async (payload) => {
      const content = {
        content: payload.content,
        allowedMentions: { parse: [] },
      };
      if (!replied) {
        replied = true;
        return interaction.editReply(content);
      }
      return interaction.followUp({ ...content, flags: 64 });
    };
    try {
      const selected = interaction.options.getString("model");
      const result = await handleMessage({
        id: interaction.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        author: interaction.user,
        member: interaction.member,
        modelSelection:
          selected === "astra"
            ? { model: "gpt-6-astra", reasoningEffort: "high", explicit: true }
            : selected === "sol"
              ? { model: "gpt-5.6-sol", reasoningEffort: "low", explicit: true }
              : undefined,
        privateReply: true,
        ownerAvatarUrl:
          interaction.member?.displayAvatarURL?.({
            extension: "png",
            size: 256,
          }) ??
          interaction.user?.displayAvatarURL?.({
            extension: "png",
            size: 256,
          }),
        content: `/ido ${interaction.options.getSubcommandGroup?.(false) ? `${interaction.options.getSubcommandGroup(false)} ` : ""}${interaction.options.getSubcommand()} ${interaction.options.getString("input") ?? ""}`,
        channel: { send },
      });
      if (!replied)
        await send({
          content:
            result === false
              ? "操作を受け付けられませんでした。"
              : "受け付けました。返答・結果はこのチャンネルへ表示します。",
        });
    } catch {
      await send({
        content: "操作に失敗しました。状態を確認して再度お試しください。",
      });
    }
    return true;
  };
}

export const IDOBATA_HELP = [
  "🪣 **井戸Bot — 話す・作る・試す**",
  "会話は共有コンテキストへ。声の依頼は「井戸Bot、〜して」。",
  "`/ido ask 質問` 即答 · `/ido context` 議事録",
  "`/ido task 依頼` 実装 · `/ido research 調査内容`",
  "`/ido benchmark 比較内容` · `/ido test 検証内容`",
  "`/ido status ページ番号` 通話状態・作業一覧 · `/ido stop タスクID`",
  "`/ido agents` 接続中のCodexエージェントと担当Issue数",
  "`/ido agent connect` 自分のPCのCodex Workerを安全に接続",
  "`/ido result タスクID` 保存済みの結果と検証記録",
  "`/ido quiet` 読み上げ停止",
  "`/ido live on` GPT-Liveを30分比較 · `off` 元に戻す",
  "`/ido join` 通話へ接続 · `/ido leave` 通話から退出",
  "`/ido follow タスクID 追加指示` · `/ido new` 新しい会議",
  "`/ido apply タスクID 実行版` 確認した差分を作業場所へ反映",
  "作業・中断・新規会議の操作権限は、このBotの設定に従います。",
  "作業結果は専用スレッドとこの会話へ戻ります。",
  "通常の作業はSol low。Astraは作業作成時のmodel指定か「Astraで〜して」と明示した作業だけで使用します。",
  "追加指示は実行中にも届きます。試用版がある場合はカードのURLから開き、「この版を試した」で報告できます。",
].join("\n");

const displayTaskState = (state) =>
  ({
    queued: "待機中",
    running: "実行中",
    interrupted: "中断・再開待ち",
    failed: "失敗",
    completed: "完了",
    cancelled: "中止",
  })[state] ??
  state ??
  "不明";

function taskStatus(tasks, session, argument) {
  if (argument && !/^[1-9][0-9]{0,5}$/.test(argument))
    return "ページ番号は1以上の整数で指定してください。`/ido status 1`";
  const page = argument ? Number(argument) : 1;
  const byId = new Map(
    tasks.map((task, index) => [task.id, { ...task, index }]),
  );
  for (const task of session.pendingTasks ?? []) {
    byId.set(task.id, {
      ...byId.get(task.id),
      ...task,
      pending: true,
      state: task.cancelled
        ? "取り消し保存を再試行中"
        : task.rejectionReason
          ? "受付不可・通知を再試行中"
          : "受付保存を再試行中",
    });
  }
  const priority = (task) =>
    task.pending || ["queued", "running"].includes(task.state)
      ? 0
      : task.resultDeliveryPending ||
          ["interrupted", "failed"].includes(task.state)
        ? 1
        : 2;
  const ordered = [...byId.values()].sort(
    (a, b) =>
      priority(a) - priority(b) ||
      (b.createdAt ?? b.index ?? 0) - (a.createdAt ?? a.index ?? 0),
  );
  const rows = [
    ...(session.pendingControls ?? []).map((control) =>
      control.type === "status"
        ? "作業状況の返信を再試行中"
        : control.type === "reply"
          ? "会話への回答を再送待ち"
          : `操作の保存・通知を再試行中 · ${control.taskId ?? "対象確認待ち"}`,
    ),
    ...ordered.map(
      (task) =>
        `\`${task.issueId ?? task.id}\` ${displayTaskState(task.state)}${task.resultDeliveryPending ? "（結果送信待ち）" : ""} · ${escapeDiscordMarkdown(boundText(String(task.title ?? "").replace(/\s+/g, " "), 100))}${task.assignedAgentName || task.assignedAgentId ? ` · 担当 ${escapeDiscordMarkdown(task.assignedAgentName ?? task.assignedAgentId)}` : ""}${task.threadId ? ` <#${task.threadId}>` : ""}`,
    ),
  ];
  if (!rows.length)
    return "まだ作業はありません。`/ido task 依頼` で開始できます。";
  const pages = [];
  let current = [];
  let length = 0;
  for (const row of rows) {
    const bounded = boundText(row, 400);
    if (
      current.length &&
      (length + bounded.length + 1 > 1700 || current.length >= 8)
    ) {
      pages.push(current.join("\n"));
      current = [];
      length = 0;
    }
    current.push(bounded);
    length += bounded.length + 1;
  }
  if (current.length) pages.push(current.join("\n"));
  if (page > pages.length)
    return `ページ番号は1〜${pages.length}で指定してください。\`/ido status 1\``;
  return `作業一覧 · ${byId.size}件 · ${page}/${pages.length}ページ\n${pages[page - 1]}${page < pages.length ? `\n次へ: /ido status ${page + 1}` : ""}${page > 1 ? `\n前へ: /ido status ${page - 1}` : ""}`;
}

export function hasTaskChanges(artifacts) {
  if (typeof artifacts?.hasChanges === "boolean") return artifacts.hasChanges;
  if (typeof artifacts?.status === "string")
    return Boolean(artifacts.status.trim());
  return undefined;
}

function isEmptyTaskRevision(task, revision) {
  return (
    task?.state === "completed" &&
    Number(revision) === task.artifacts?.runRevision &&
    hasTaskChanges(task.artifacts) === false
  );
}

export function taskControls(
  taskId,
  state,
  revision,
  applied = false,
  hasChanges,
  preview,
) {
  return [
    {
      type: 1,
      components: [
        ...(preview?.state === "available"
          ? [
              {
                type: 2,
                style: 2,
                label: "この版を試した",
                custom_id: `ido:tried:${taskId}:${preview.runRevision}`,
                disabled: state !== "completed",
              },
            ]
          : []),
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
          label: applied
            ? "反映済み"
            : state === "completed" && hasChanges === false
              ? "差分なし"
              : "差分を反映",
          custom_id: `ido:apply:${taskId}${revision ? `:${revision}` : ""}`,
          disabled:
            state !== "completed" ||
            applied ||
            !Number.isSafeInteger(revision) ||
            revision < 1 ||
            hasChanges !== true,
        },
      ],
    },
  ];
}

export function createIdobataInteractionHandler({ config, taskQueue }) {
  return async (interaction) => {
    const match = String(interaction.customId ?? "").match(
      /^ido:(follow|instruction|stop|apply|tried):([a-zA-Z0-9_-]+)(?::([1-9][0-9]*))?$/,
    );
    if (!match || interaction.guildId !== config.guildId) return false;
    const reply = (content) =>
      interaction.reply({ content, flags: 64, allowedMentions: { parse: [] } });
    const userId = interaction.user?.id;
    if (
      !config.allParticipantsOperate &&
      userId !== config.allowedUserId &&
      !(config.operatorUserIds ?? []).includes(userId)
    )
      return reply("この操作は設定済みの操作担当者だけが使えます。");
    const [, action, taskId, revision] = match;
    if (!taskQueue?.tasks.has(taskId))
      return reply("タスクが見つかりません。作業一覧を確認してください。");
    if (action === "tried") {
      await interaction.deferReply({ flags: 64 });
      try {
        return interaction.editReply(
          (await taskQueue.confirmPreview(taskId, Number(revision), userId))
            ? "この実行版を試したという報告を保存しました。気づいた点は「追加指示」で同じ作業へ伝えられます。"
            : "この試用版は停止済みか更新されています。最新のタスクカードから試してください。",
        );
      } catch {
        return interaction.editReply(
          "試用報告を保存できませんでした。もう一度試してください。",
        );
      }
    }
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
      if (isEmptyTaskRevision(taskQueue.tasks.get(taskId), revision))
        return interaction.editReply(
          "この実行版に反映する差分はありません。検証記録を確認してください。",
        );
      try {
        return interaction.editReply(
          (await taskQueue.applyTask(
            taskId,
            revision ? Number(revision) : undefined,
          ))
            ? "差分を元の作業場所へ反映しました。動作確認に進めます。"
            : "反映できません。完了済み・未反映の最新の実行版を、タスクカードで確認してください。",
        );
      } catch {
        return interaction.editReply(
          "元の作業場所に変更があるか、差分が競合しています。添付差分を確認してください。",
        );
      }
    }
    const message = {
      taskId,
      requestKey: interaction.id
        ? `discord-interaction:${interaction.id}`
        : undefined,
      userId,
      ownerUserId: userId,
      content:
        action === "stop"
          ? "停止"
          : interaction.fields.getTextInputValue("instruction"),
    };
    await interaction.deferReply({ flags: 64 });
    let result;
    try {
      result = await (taskQueue.handleTaskMessageDurable?.(message) ??
        taskQueue.handleTaskMessage(message));
    } catch {
      return interaction.editReply(
        "追加指示を保存できなかったため受け付けていません。保存先を確認して再試行してください。",
      );
    }
    return interaction.editReply(
      result?.persisted === false
        ? "停止しましたが、停止状態を保存できませんでした。再起動後は作業一覧を確認してください。"
        : !result
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
  input = session,
  taskQueue,
  resetMeeting = async () => undefined,
  getVoiceStatus = () => "",
  reconnectVoice,
  leaveVoice,
  setLiveMode,
  workerGateway,
}) {
  const seen = new Set();
  const commandChannelIds = new Set(
    [
      config.textChannelId,
      config.agentCoordinationChannelId,
      ...(config.codexAgents ?? []).map(({ channelId }) => channelId),
    ].filter(Boolean),
  );
  return async (message) => {
    if (message.author?.bot || message.guildId !== config.guildId) return false;
    const authorized =
      (config.allParticipantsOperate && Boolean(message.author?.id)) ||
      message.author?.id === config.allowedUserId ||
      (config.operatorUserIds ?? []).includes(message.author?.id);
    if (message.id && seen.has(message.id)) return false;
    if (message.id) {
      seen.add(message.id);
      if (seen.size > 1000) seen.delete(seen.values().next().value);
    }
    const requestKey = message.id
      ? `discord:${message.guildId}:${message.channelId}:${message.id}`
      : undefined;
    if (!commandChannelIds.has(message.channelId)) {
      if (!authorized) return false;
      const instruction = {
        threadId: message.channelId,
        requestKey,
        userId: message.author.id,
        ownerUserId: message.author.id,
        content: message.content,
      };
      try {
        return await (taskQueue?.handleThreadMessageDurable?.(instruction) ??
          taskQueue?.handleThreadMessage(instruction) ??
          false);
      } catch {
        return { type: "save_failed" };
      }
    }
    const content = String(message.content ?? "").trim();
    const match = content.match(/^[!/]ido(?:\s+(\w+))?(?:\s+([\s\S]*))?$/i);
    const reply = (text, components = []) =>
      message.channel.send({
        content: boundText(text, 1950),
        components,
        allowedMentions: { parse: [] },
        flags: config.silentMessages === false ? undefined : 4096,
      });
    if (!match) {
      if (message.channelId !== config.textChannelId) return false;
      if (content)
        await input.addText?.(content, {
          inputId: message.id,
          userId: message.author.id,
          speakerName: message.member?.displayName ?? message.author.username,
        });
      return Boolean(content);
    }
    const command = (match[1] ?? "help").toLowerCase();
    const argument = (match[2] ?? "").trim();
    if (command === "agent") {
      if (!message.privateReply)
        return reply(
          "接続コードを公開しないため、Discordの `/ido agent` コマンドを使ってください。",
        );
      if (!authorized)
        return reply("このサーバーでWorkerを登録する権限がありません。");
      const action = argument.toLowerCase();
      if (!workerGateway)
        return reply("分散Worker Gatewayはまだ有効になっていません。");
      if (action === "connect") {
        const pairing = workerGateway.createPairing({
          ownerUserId: message.author.id,
          ownerDisplayName:
            message.member?.displayName ??
            message.author.globalName ??
            message.author.username,
          ownerAvatarUrl: message.ownerAvatarUrl,
        });
        const remaining = Math.max(
          1,
          Math.ceil((pairing.expiresAt - Date.now()) / 60_000),
        );
        return reply(
          [
            "🔐 **個人Codex Workerの接続コード**",
            "1. 下の参加手順を開き、自分のPCで接続画面を起動します。",
            "2. 画面の「OpenAIでログイン」で認証します。パスワードはOpenAI公式ページだけに入力してください。",
            "3. 同じPC・同じブラウザで下の「自動入力」を押すと、開いている接続画面へ接続先と参加コードが入ります。接続画面に戻り、作業フォルダーを選んで接続してください。",
            "ボタンがない・使えない場合は、次の参加情報を接続画面の「Discordの参加情報」に貼り付けて読み込みます。リンク・参加情報は他人に共有しないでください。",
            `\`${encodeAgentInvitation(pairing)}\``,
            `Gateway: \`${pairing.gatewayUrl}\``,
            `コード: \`${pairing.code}\`（約${remaining}分で失効・1回限り）`,
            "Windowsは `Start Agent.cmd` をダブルクリックで起動できます。既定ではタスクごとに本人の実行確認が必要です。",
            pairing.gatewayUrl.startsWith("ws:")
              ? "⚠️ 現在はBotと同じPCからの接続専用です。他のPCで参加するには管理者による公開WSSの設定が必要です。"
              : "",
            "Discord・Codex・GitHubのログイン情報をBotへ送らないでください。",
          ].join("\n"),
          agentGuideComponents(config.agentJoinGuideUrl, pairing),
        );
      }
      if (action === "disconnect") {
        const revoked = await workerGateway.revokeOwner(message.author.id);
        return reply(
          revoked.length
            ? `自分のWorker ${revoked.length}件を切断し、接続資格を失効しました。`
            : "接続中の自分のWorkerはありません。",
        );
      }
      if (action === "status") {
        const workers = workerGateway.statusForOwner(message.author.id);
        return reply(
          workers.length
            ? workers
                .map(
                  (worker) =>
                    `**${escapeDiscordMarkdown(worker.name)}** \`${worker.agentId}\` · ${worker.online ? "接続中" : "オフライン"} · ${worker.capabilities.join(", ") || "担当未設定"}`,
                )
                .join("\n")
            : "登録済みの自分のWorkerはありません。",
        );
      }
      return reply(
        "`/ido agent connect`、`disconnect`、`status`のいずれかを選んでください。",
      );
    }
    if (command === "help") return reply(IDOBATA_HELP);
    if (command === "agents") return reply(agentStatus(taskQueue));
    if (command === "status") {
      return reply(
        [
          getVoiceStatus(),
          taskStatus(taskQueue?.list() ?? [], session, argument),
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
    if (command === "result") {
      if (!/^[a-zA-Z0-9_-]+$/.test(argument))
        return reply(
          "`/ido result タスクID` と入力してください。IDは `/ido status` で確認できます。",
        );
      const result = taskQueue?.getTaskResult?.(argument);
      if (!result)
        return reply(
          "そのタスクは見つかりません。`/ido status` でIDを確認してください。",
        );
      const current = `現在: ${displayTaskState(result.currentState)}${result.currentRunRevision ? ` · 実行版 ${result.currentRunRevision}` : ""}`;
      if (!result.result)
        return reply(
          `\`${result.id}\` ${current}\n保存済みの完了結果はまだありません。`,
        );
      const text = [
        `📦 **保存済みの結果** \`${result.id}\` ${result.runRevision ? `実行版 ${result.runRevision}` : "実行版は未確認"}`,
        escapeDiscordMarkdown(boundText(result.title, 160)),
        current,
        result.verification,
        result.threadId ? `詳細: <#${result.threadId}>` : "",
        result.result,
      ]
        .filter(Boolean)
        .join("\n");
      for (const chunk of splitDiscordText(text)) await reply(chunk);
      return true;
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
      await input.addText?.(argument, {
        inputId: message.id,
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
    if (command === "leave") {
      if (!leaveVoice) return reply("この接続では退出を操作できません。");
      await leaveVoice();
      return reply(
        "通話から退出しました。`/ido join` で戻れます。背景の作業は続行します。",
      );
    }
    if (command === "live") {
      if (!setLiveMode || !["on", "off"].includes(argument))
        return reply(
          "`/ido live on` で30分間の比較を開始、`/ido live off` で元の音声方式へ戻します。",
        );
      const result = await setLiveMode(argument === "on");
      return reply(
        result === "live"
          ? "GPT-Liveで30分間の比較を開始しました。切断・期限終了時は元の音声方式へ戻ります。作業は通常Sol lowです。"
          : result === "legacy"
            ? "元のSTT/TTS方式へ戻しました。"
            : result === "busy"
              ? "音声方式を切り替えています。"
              : "GPT-Liveを開始できませんでした。通話接続とAPIの利用可否を確認してください。",
      );
    }
    if (command === "reconnect" || command === "join") {
      if (!reconnectVoice)
        return reply("この接続では通話の再接続を操作できません。");
      await reply("通話の接続を確認しています。作業はそのまま続行します。");
      const result = await reconnectVoice();
      return reply(
        result === "connected"
          ? "通話に接続しました。"
          : result === "busy"
            ? "通話の再接続は進行中です。`/ido status` で確認できます。"
            : result === "stopped"
              ? "Botを停止しているため再接続しませんでした。"
              : result === "unavailable"
                ? "通話接続が終了しているため再利用できません。Botを再起動してください。"
                : "通話へ再接続できませんでした。Botの通話権限と接続状態を確認して、もう一度 `/ido reconnect` を実行してください。",
      );
    }
    if (command === "quiet") {
      const result = await session.silenceSpeech?.();
      return reply(
        !result
          ? "このモードでは読み上げを操作できません。"
          : result.persisted === false
            ? "読み上げを停止しました。停止の記録は保存を再試行しています。"
            : "読み上げを停止しました。次の質問には通常どおり応答します。",
      );
    }
    if (command === "new") {
      if (!(await session.newMeeting?.(resetMeeting)))
        return reply(
          "会議を切り替えられませんでした。現在の会話は保持しています。処理・保存状態を確認して `/ido new` を再試行してください。",
        );
      return reply(
        "新しい会議を開始しました。以前の会話ログとタスクの成果は保存されています。",
      );
    }
    if (!taskQueue)
      return reply(
        "作業モードは未設定です。管理者が POWER_MODE を有効にしてください。",
      );
    if (command === "apply") {
      const [taskId, revision, extra] = argument.split(/\s+/);
      if (extra || (revision && !/^[1-9][0-9]*$/.test(revision)))
        return reply(
          "`/ido apply タスクID 実行版` と入力してください。実行版は最新の添付に記載されています。",
        );
      if (isEmptyTaskRevision(taskQueue.tasks?.get(taskId), revision))
        return reply(
          "この実行版に反映する差分はありません。検証記録を確認してください。",
        );
      try {
        return reply(
          (await taskQueue.applyTask(
            taskId,
            revision ? Number(revision) : undefined,
          ))
            ? "✅ 差分を元の作業場所へ反映しました。起動・動作確認に進めます。"
            : "反映できる最新の完了タスクを指定してください。実行版が古い場合は最新の添付を確認してください。",
        );
      } catch {
        return reply(
          "開始後に元の作業場所が変わったか、差分が競合しています。自動反映を止めました。添付差分を確認してください。",
        );
      }
    }
    if (["task", "research", "benchmark", "test"].includes(command)) {
      if (!argument) return reply("コマンドの後に依頼内容を入れてください。");
      const task = {
        title: argument.slice(0, 100),
        request: argument,
        requestKey,
        context:
          session.getContextSnapshot?.() ??
          session.minutes + "\n" + JSON.stringify(session.results ?? []),
        meetingId: session.meetingId,
        kind: command === "task" ? "implementation" : command,
        complexity: "routine",
        modelSelection: message.modelSelection ?? requestedVoiceModel(argument),
      };
      let accepted;
      try {
        accepted = await (taskQueue.enqueueDurable?.(task) ??
          taskQueue.enqueue(task));
      } catch {
        return reply(
          "依頼を保存できなかったため作業を開始していません。保存先を確認して再試行してください。",
        );
      }
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
      const instruction = {
        taskId,
        requestKey,
        userId: message.author.id,
        ownerUserId: message.author.id,
        content: command === "stop" ? "停止" : words.join(" "),
      };
      let action;
      try {
        action =
          (command === "stop" && (await session.cancelPendingTask?.(taskId))) ||
          (await (taskQueue.handleTaskMessageDurable?.(instruction) ??
            taskQueue.handleTaskMessage(instruction)));
      } catch {
        return reply(
          "追加指示を保存できなかったため受け付けていません。保存先を確認して再試行してください。",
        );
      }
      if (action?.persisted === false)
        return reply(
          "停止しましたが、停止状態を保存できませんでした。再起動後は作業一覧を確認してください。",
        );
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

function agentStatus(taskQueue) {
  const agents = taskQueue?.agentTeam?.list?.() ?? [];
  const tasks = taskQueue?.list?.() ?? [];
  return [
    `🤖 **接続中のCodexエージェント ${agents.length}体**`,
    ...agents.map((agent) => {
      const assigned = tasks.filter(
        ({ assignedAgentId }) => assignedAgentId === agent.id,
      );
      const active = assigned.filter(({ state }) =>
        ["queued", "running"].includes(state),
      ).length;
      return `**${escapeDiscordMarkdown(agent.name)}** \`${agent.id}\` · ${agent.transport === "remote" ? (agent.online ? "Worker接続中" : "Workerオフライン") : "Botホスト"} · 稼働 ${active}/${agent.maximumConcurrentTasks} · Issue累計 ${assigned.length}件 · 担当 ${agent.capabilities.join(", ") || "指定なし"}`;
    }),
  ].join("\n");
}
