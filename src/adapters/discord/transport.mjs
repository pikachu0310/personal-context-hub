import { safeNotify } from "../../engine/telemetry.mjs";
import { SpeechStartGate } from "./speech-start.mjs";
import { formatTaskPreview } from "../../engine/output/preview.mjs";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { formatVerificationEvidence } from "../../engine/evidence.mjs";

import { readFile } from "node:fs/promises";

import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  entersState,
} from "@discordjs/voice";
import { MessageFlags, RESTJSONErrorCodes } from "discord.js";
import prism from "prism-media";

import { taskControls, hasTaskChanges } from "./commands.mjs";

import {
  PcmTurnBuffer,
  PcmSegmentBuffer,
  wrapPcmAsWav,
} from "../../engine/input/audio.mjs";

import { boundText, formatElapsedTime } from "../../engine/shared.mjs";
import { escapeDiscordMarkdown } from "./presentation.mjs";
import { ttsPcm24kMonoToDiscordRaw } from "./audio-format.mjs";

const PCM_BYTES_PER_SECOND = 48_000 * 2 * 2;
const AUDIO_RETRY_MESSAGE =
  "⚠️ 音声データを処理できませんでした。もう一度話してください。";

export function logAudioFailure(logger, event, error) {
  try {
    logger.error?.({
      component: "discord-voice",
      event,
      errorName: error?.name ?? "Error",
    });
  } catch {
    // Audio cleanup must not depend on a logger implementation.
  }
}

export function logInfoQuietly(logger, entry) {
  try {
    logger.info?.(entry);
  } catch {
    // Logging must never change service readiness or cleanup semantics.
  }
}

export async function destroyQuietly(resource) {
  try {
    await resource?.destroy?.();
  } catch {
    // Cleanup must preserve the original startup failure or shutdown signal.
  }
}

export function serializeAudioPlayback(play) {
  let pending = Promise.resolve();
  return (audio, options = {}) => {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const next = pending.then(() => {
      if (options.signal?.aborted) throw options.signal.reason;
      return play(audio, options);
    });
    pending = next.catch(() => undefined);
    return next;
  };
}

export function createDiscordPlayer(
  connection,
  logger = console,
  { speechStartSilenceMs = 1_000 } = {},
) {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  player.on("error", (error) => {
    logAudioFailure(logger, "playback_failed", error);
  });
  connection.subscribe(player);
  const speechStart = new SpeechStartGate(connection.receiver.speaking, {
    silenceMs: speechStartSilenceMs,
  });
  const serializedPlay = serializeAudioPlayback(
    async (ttsPcm, { signal, onPlaybackState } = {}) => {
      if (signal?.aborted) throw signal.reason;
      const stopOnAbort = () => player.stop(true);
      signal?.addEventListener("abort", stopOnAbort, { once: true });
      try {
        const raw = ttsPcm24kMonoToDiscordRaw(ttsPcm);
        const seconds = raw.length / PCM_BYTES_PER_SECOND;
        safeNotify(onPlaybackState, {
          status: "waiting",
          reason: "speaker_silence",
        });
        await speechStart.runWhenQuiet(
          () => {
            const resource = createAudioResource(Readable.from(raw), {
              inputType: StreamType.Raw,
            });
            player.play(resource);
          },
          { signal },
        );
        await entersState(player, AudioPlayerStatus.Playing, 5_000);
        safeNotify(onPlaybackState, { status: "running", reason: undefined });
        await entersState(
          player,
          AudioPlayerStatus.Idle,
          Math.max(10_000, Math.ceil(seconds * 1_000) + 10_000),
        );
      } finally {
        signal?.removeEventListener("abort", stopOnAbort);
      }
    },
  );
  const play = (audio, options = {}) => {
    safeNotify(options.onPlaybackState, {
      status: "waiting",
      reason: "playback_queue",
    });
    return serializedPlay(audio, options);
  };
  play.dispose = () => speechStart.dispose();
  return play;
}

export function createDiscordLiveOutput(connection, logger = console) {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });
  player.on("error", (error) =>
    logAudioFailure(logger, "live_playback_failed", error),
  );
  connection.subscribe(player);
  let queued = Buffer.alloc(0);
  let stream;
  let closed = false;
  const clear = () => {
    queued = Buffer.alloc(0);
    stream?.destroy();
    stream = new Readable({ read() {}, highWaterMark: 3840 });
    player.play(createAudioResource(stream, { inputType: StreamType.Raw }));
  };
  clear();
  const timer = setInterval(() => {
    if (closed || stream.readableLength > 3840) return;
    const frame = Buffer.alloc(960);
    queued.copy(frame, 0, 0, Math.min(960, queued.length));
    queued = queued.subarray(Math.min(960, queued.length));
    stream.push(ttsPcm24kMonoToDiscordRaw(frame));
  }, 20);
  timer.unref();
  return {
    append(pcm) {
      if (closed) return;
      if (queued.length + pcm.length > 24000 * 2 * 5) {
        clear();
        logInfoQuietly(logger, {
          component: "discord-voice",
          event: "live_output_overflow",
        });
        return;
      }
      queued = Buffer.concat([queued, pcm]);
    },
    clear,
    close() {
      closed = true;
      clearInterval(timer);
      queued = Buffer.alloc(0);
      stream.destroy();
      player.stop(true);
    },
  };
}

export function subscribeToAllowedSpeaker({
  connection,
  config,
  session,
  postText,
  logger,
  resolveSpeakerName = (userId) => userId,
  createDecoder = (options) => new prism.opus.Decoder(options),
  live,
}) {
  const active = new Set();
  const notify = (content) =>
    Promise.resolve()
      .then(() => postText(content))
      .catch(() => undefined);
  connection.receiver.speaking.on("end", (userId) => live?.speakerEnd(userId));
  connection.receiver.speaking.on("start", (userId) => {
    if (!config.listenToEveryone && userId !== config.allowedUserId) return;
    live?.speakerStart(userId);
    if (active.has(userId)) return;
    const startedAt = Date.now();
    active.add(userId);
    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: config.silenceMs,
      },
    });
    const decoder = createDecoder({
      rate: 48_000,
      channels: 2,
      frameSize: 960,
    });
    const segmented =
      config.voiceMode === "meeting" &&
      typeof session.finishUtterance === "function";
    const turnBuffer = segmented
      ? new PcmSegmentBuffer(config)
      : new PcmTurnBuffer(config);
    const utteranceId = randomUUID();
    if (segmented)
      session.beginUtterance?.(utteranceId, {
        userId,
        speakerName: resolveSpeakerName(userId),
        startedAt,
      });
    let segmentIndex = 0;
    let segmentedBytes = 0;
    let utteranceFinished = false;
    const enqueueSegment = (pcm) => {
      const accepted = session.enqueue(wrapPcmAsWav(pcm), {
        userId,
        speakerName: resolveSpeakerName(userId),
        startedAt: startedAt + Math.floor(segmentedBytes / 192),
        utteranceId,
        segmentIndex: segmentIndex++,
      });
      segmentedBytes += pcm.length;
      return accepted;
    };
    const finishUtterance = (incomplete = false) => {
      if (!segmented || utteranceFinished) return;
      utteranceFinished = true;
      void session
        .finishUtterance(utteranceId, segmentIndex, { incomplete })
        .catch((error) =>
          logAudioFailure(logger, "utterance_finalize_failed", error),
        );
    };
    let discardedTurn = false;
    let finalized = false;

    decoder.on("data", (chunk) => {
      if (discardedTurn) return;
      try {
        live?.input(userId, chunk);
        if (segmented) {
          for (const pcm of turnBuffer.push(chunk)) enqueueSegment(pcm);
          return;
        }
        if (turnBuffer.push(chunk)) return;
        discardedTurn = true;
        active.delete(userId);
        opusStream.destroy();
        decoder.destroy();
        void notify(
          `⚠️ 発話が${config.maximumAudioSeconds}秒を超えたため破棄しました。`,
        );
      } catch (error) {
        discardedTurn = true;
        finishUtterance(true);
        active.delete(userId);
        opusStream.destroy();
        decoder.destroy();
        logAudioFailure(logger, "receive_frame_failed", error);
        void notify(AUDIO_RETRY_MESSAGE);
      }
    });
    const release = () => {
      active.delete(userId);
      live?.speakerEnd(userId);
    };
    opusStream.once("error", (error) => {
      discardedTurn = true;
      finalized = true;
      finishUtterance(true);
      release();
      decoder.destroy();
      logAudioFailure(logger, "receive_failed", error);
      void notify(AUDIO_RETRY_MESSAGE);
    });
    opusStream.once("close", release);
    decoder.once("close", () => {
      release();
      if (!finalized) finishUtterance(true);
    });
    decoder.once("error", (error) => {
      discardedTurn = true;
      finalized = true;
      finishUtterance(true);
      release();
      opusStream.destroy();
      logAudioFailure(logger, "decode_failed", error);
      void notify(AUDIO_RETRY_MESSAGE);
    });
    decoder.once("end", () => {
      if (finalized) return;
      finalized = true;
      release();
      if (discardedTurn) return;
      try {
        if (segmented) {
          const remaining = turnBuffer.finish();
          if (remaining) enqueueSegment(remaining);
          finishUtterance();
          return;
        }
        const completed = turnBuffer.finish();
        if (completed.status !== "accepted") return;
        if (
          !session.enqueue(wrapPcmAsWav(completed.pcm), {
            userId,
            speakerName: resolveSpeakerName(userId),
            startedAt,
          })
        ) {
          void notify(
            "⚠️ 音声ターンが混雑しています。少し待ってからもう一度話してください。",
          );
        }
      } catch (error) {
        finishUtterance(true);
        logAudioFailure(logger, "receive_finalize_failed", error);
        void notify(AUDIO_RETRY_MESSAGE);
      }
    });
    opusStream.pipe(decoder);
  });
}

export function createDiscordMessagePayload(
  content,
  { silent = true, idempotencyKey } = {},
) {
  return {
    content,
    allowedMentions: { parse: [] },
    ...(silent ? { flags: MessageFlags.SuppressNotifications } : {}),
    ...(idempotencyKey
      ? {
          nonce: createHash("sha256")
            .update(String(idempotencyKey))
            .digest("hex")
            .slice(0, 24),
          enforceNonce: true,
        }
      : {}),
  };
}

export function createEditableDiscordPost(textChannel, { silent = true } = {}) {
  let message;
  return async (content) => {
    const payload = createDiscordMessagePayload(content, { silent });
    if (!message || typeof message.edit !== "function") {
      message = await textChannel.send(payload);
      return message;
    }
    try {
      message = await message.edit({
        content,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      if (error?.code !== RESTJSONErrorCodes.UnknownMessage) throw error;
      message = await textChannel.send(payload);
    }
    return message;
  };
}

export function createMinutesDiscordPost(textChannel, options = {}) {
  let message;
  let restored = false;
  let pinAttempted = false;
  const pin = async () => {
    if (pinAttempted || message?.pinned) return;
    pinAttempted = true;
    await message?.pin?.().catch(() => undefined);
  };
  return async (content, { minutes = "" } = {}) => {
    if (!restored) {
      restored = true;
      if (options.botUserId && textChannel.messages?.fetch) {
        const recent = await textChannel.messages
          .fetch({ limit: 50 })
          .catch(() => undefined);
        message = recent?.find(
          (item) =>
            item.author?.id === options.botUserId &&
            item.content?.startsWith("📝 **議事録"),
        );
      }
    }
    const payload = {
      ...createDiscordMessagePayload(content, options),
      files: [
        {
          attachment: Buffer.from(minutes || content, "utf8"),
          name: "minutes.md",
        },
      ],
      attachments: [],
    };
    if (message) {
      try {
        message = await message.edit(payload);
        await pin();
        return message;
      } catch (error) {
        if (error?.code !== RESTJSONErrorCodes.UnknownMessage) throw error;
      }
    }
    message = await textChannel.send(payload);
    // Pin only our minutes message; if permission is absent, /ido context and
    // the full attachment still make the current minutes available.
    pinAttempted = false;
    await pin();
    return message;
  };
}

const DISCORD_TASK_STATES = Object.freeze({
  queued: ["⏳", "待機中"],
  running: ["🟡", "実行中"],
  completed: ["✅", "完了"],
  failed: ["⚠️", "失敗"],
  cancelled: ["⏹️", "中止"],
  interrupted: ["⏸️", "再起動で中断・追加指示で再開"],
});

export function formatDiscordTaskCard(
  task,
  { state = "queued", threadId, elapsedMs, pendingInstructions = 0 } = {},
) {
  const [icon, defaultLabel] = DISCORD_TASK_STATES[state] ?? ["🧰", state];
  const label =
    state === "completed" && task.preview
      ? task.preview.state === "available"
        ? task.preview.confirmations?.length >= 4
          ? "4人が試用済み"
          : task.preview.browserVerified
            ? "試用版あり"
            : "起動済み・操作未確認"
        : "実装処理終了・試用状態を確認"
      : defaultLabel;
  const id = String(task.id ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "");
  const title = escapeDiscordMarkdown(
    boundText(String(task.title ?? "").replace(/[\r\n]+/g, " "), 120) ||
      "Codexタスク",
  );
  return [
    `${icon} **Codexタスク** \`${id || "unknown"}\``,
    `**${title}**`,
    `状態: **${label}**${Number.isFinite(elapsedMs) ? ` · ${formatElapsedTime(elapsedMs)}` : ""}${pendingInstructions > 0 ? ` · 追加指示 **${pendingInstructions}件待機**` : ""}`,
    task.profile
      ? `担当: ${task.profile.kind} · ${task.profile.model ?? "default"} / ${task.profile.modelReasoningEffort}`
      : `担当: ${task.kind ?? "implementation"}`,
    threadId ? `ログ: <#${threadId}>` : "ログスレッドを準備しています…",
    task.artifacts?.runRevision
      ? `実行版: **${task.artifacts.runRevision}**${task.appliedRevision === task.artifacts.runRevision ? " · 反映済み" : ""}`
      : "",
    state === "completed" && hasTaskChanges(task.artifacts) === false
      ? "差分: なし（検証記録を確認できます）"
      : "",
    state === "completed" ? formatVerificationEvidence(task.evidence) : "",
    task.preview ? formatTaskPreview(task.preview) : "",
  ].join("\n");
}

export function createDiscordArtifactPoster(
  thread,
  task,
  { silent = true } = {},
) {
  return async (artifacts, evidence, { idempotencyKey, signal } = {}) => {
    signal?.throwIfAborted();
    const patch = await readFile(artifacts.patchPath);
    if (
      patch.length > 1_000_000 ||
      /(?:BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|sk-[A-Za-z0-9_-]{24,})/.test(
        patch.toString(),
      )
    ) {
      await thread.send(
        createDiscordMessagePayload(
          "差分はローカルworkspaceに保存しました。サイズまたは秘密値の検査により自動添付を省略しました。",
          { silent, idempotencyKey },
        ),
      );
      return;
    }
    await thread.send({
      ...createDiscordMessagePayload(
        patch.length
          ? `📎 実行版 ${artifacts.runRevision ?? 1} の差分と検証記録。前回反映した時点（未反映なら開始時点）からの変更です。確認後 \`/ido apply ${task.id} ${artifacts.runRevision ?? 1}\` で反映できます。`
          : `📎 実行版 ${artifacts.runRevision ?? 1} の検証記録。変更差分はありません。`,
        { silent, idempotencyKey },
      ),
      files: [
        ...(patch.length
          ? [
              {
                attachment: patch,
                name: `${task.id}-r${artifacts.runRevision ?? 1}.patch`,
              },
            ]
          : []),
        {
          attachment: Buffer.from(JSON.stringify(evidence ?? {}, null, 2)),
          name: `${task.id}-r${artifacts.runRevision ?? 1}-verification.json`,
        },
      ],
    });
  };
}

export function createDiscordTaskCardUpdater(
  textChannel,
  task,
  threadId,
  starter,
  { silent = true } = {},
) {
  let updating = Promise.resolve();
  const update = (options = {}) => {
    const next = updating.then(async () => {
      const { state, elapsedMs, pendingInstructions, signal, isCurrent } =
        options;
      signal?.throwIfAborted();
      if (isCurrent && !isCurrent()) return starter;
      const payload = {
        content: formatDiscordTaskCard(task, {
          state,
          threadId,
          elapsedMs,
          pendingInstructions,
        }),
        allowedMentions: { parse: [] },
        components: taskControls(
          task.id,
          state,
          task.artifacts?.runRevision,
          Boolean(
            task.appliedRevision &&
            task.appliedRevision === task.artifacts?.runRevision,
          ),
          hasTaskChanges(task.artifacts),
          task.preview,
        ),
      };
      if (starter) {
        try {
          starter = await starter.edit(payload);
          return starter;
        } catch (error) {
          if (error?.code !== RESTJSONErrorCodes.UnknownMessage) throw error;
        }
      }
      signal?.throwIfAborted();
      if (isCurrent && !isCurrent()) return starter;
      starter = await textChannel.send({
        ...createDiscordMessagePayload(payload.content, {
          silent,
          idempotencyKey: `task-card:${task.id}:${task.createdAt}:${starter?.id ?? task.starterId ?? "restore"}`,
        }),
        components: payload.components,
      });
      await task.checkpoint?.();
      return starter;
    });
    updating = next.catch(() => undefined);
    return next;
  };
  return {
    update,
    get starterId() {
      return starter?.id ?? task.starterId;
    },
  };
}

export function createDiscordTaskThread(textChannel, { silent = true } = {}) {
  return async (task) => {
    const creationKey = `task-thread:${task.id}:${task.createdAt}:${task.threadId ?? "initial"}`;
    const title = String(task.title ?? "Codexタスク")
      .replace(/[\r\n]+/g, " ")
      .trim();
    const starter = await textChannel.send(
      createDiscordMessagePayload(formatDiscordTaskCard(task), {
        silent,
        idempotencyKey: `${creationKey}:card`,
      }),
    );
    if (typeof starter.startThread !== "function") {
      throw new Error("Configured text channel cannot create task threads.");
    }
    let thread;
    try {
      thread = await starter.startThread({
        name: `${task.id} ${title}`.slice(0, 100),
        autoArchiveDuration: 1_440,
        reason: "Keep Codex task output separate from meeting minutes",
      });
    } catch (error) {
      // A message and the thread started from it share an ID. The creation
      // may have succeeded even when its HTTP acknowledgement was lost.
      const existing = await textChannel.client?.channels
        ?.fetch(starter.id, { force: true })
        .catch(() => undefined);
      if (
        existing?.isThread?.() &&
        String(existing.id) === String(starter.id) &&
        String(existing.parentId) === String(textChannel.id)
      ) {
        thread = existing;
      } else {
        await starter
          .edit({
            content: formatDiscordTaskCard(task, { state: "failed" }),
            allowedMentions: { parse: [] },
          })
          .catch(() => undefined);
        throw error;
      }
    }
    const threadId = String(thread.id ?? "");
    if (!threadId) throw new Error("Created task thread has no channel ID.");
    const card = createDiscordTaskCardUpdater(
      textChannel,
      task,
      threadId,
      starter,
      { silent },
    );
    const update = card.update;
    const post = (content, { signal, idempotencyKey } = {}) => {
      if (signal?.aborted) return Promise.reject(signal.reason);
      return thread.send(
        createDiscordMessagePayload(content, { silent, idempotencyKey }),
      );
    };
    try {
      await update({ state: "queued" });
      const request = escapeDiscordMarkdown(
        boundText(task.request, 1_200) || "依頼内容を取得できませんでした。",
      );
      await post(`🧾 **依頼内容**\n${request}`, {
        idempotencyKey: `${creationKey}:request`,
      });
      await post(
        [
          "💡 **このスレッドで操作できます**",
          "追加指示: そのままメッセージを送信",
          "停止: `停止` / `中止` / `キャンセル` / `stop` / `cancel`",
          "実行中の追加指示は、現在の処理が終わり次第、同じCodexセッションで続けます。",
        ].join("\n"),
        { idempotencyKey: `${creationKey}:help` },
      ).catch(() => undefined);
    } catch (error) {
      await update({ state: "failed" }).catch(() => undefined);
      throw error;
    }
    const postArtifacts = createDiscordArtifactPoster(thread, task, { silent });
    return {
      post,
      update,
      postArtifacts,
      threadId,
      get starterId() {
        return card.starterId;
      },
    };
  };
}

export function formatDiscordTaskAction(action) {
  if (action?.persisted === false)
    return "停止しましたが、停止状態を保存できませんでした。再起動後は作業一覧を確認してください。";
  if (action?.type === "save_failed")
    return "追加指示を保存できなかったため受け付けていません。保存先を確認して再試行してください。";
  if (action?.type === "full")
    return "追加指示の枠がいっぱいです。少し待ってから再送してください。";
  if (action?.type === "cancelled") {
    return action.discardedInstructions
      ? `⏹️ タスクを停止し、未処理の追加指示${action.discardedInstructions}件も破棄しました。`
      : "⏹️ タスクを停止しました。";
  }
  if (action?.type === "instruction") {
    return action.disposition === "resumed"
      ? "▶️ 追加指示を受け付けました。同じCodexセッションで再開します。"
      : `➕ 追加指示を受け付けました。現在の処理後に続けます（待機 ${action.pendingInstructions}件）。`;
  }
  return "";
}
