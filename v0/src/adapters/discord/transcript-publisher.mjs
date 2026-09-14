import {
  DEFAULT_TIME_ZONE,
  transcriptDateKey,
  transcriptTime,
  speakerName,
} from "../../storage/transcript-format.mjs";
import { escapeDiscordMarkdown } from "./presentation.mjs";
import { createThreadParticipantJoiner } from "./discussion-threads.mjs";
const MAX_DISCORD_ARCHIVE_CHARACTERS = 1_850;
export function formatDiscordTranscriptBatch(
  statements,
  { timeZone = DEFAULT_TIME_ZONE } = {},
) {
  const ordered = [...statements].sort(
    (left, right) =>
      (left.startedAt ?? 0) - (right.startedAt ?? 0) ||
      (left.sequence ?? 0) - (right.sequence ?? 0),
  );
  const lines = ordered.map((statement) => {
    const text = String(statement.text ?? "").replace(/\r?\n/g, "\n↳ ");
    return `[${transcriptTime(statement.startedAt ?? Date.now(), timeZone)}] **${escapeDiscordMarkdown(speakerName(statement))}**: ${text}`;
  });
  const messages = [];
  let current = "📜 **会話ログ（認識テキスト）**";
  for (const line of lines) {
    if (current.length + line.length + 1 <= MAX_DISCORD_ARCHIVE_CHARACTERS) {
      current += `\n${line}`;
      continue;
    }
    if (current !== "📜 **会話ログ（認識テキスト）**") messages.push(current);
    let rest = line;
    while (rest.length > MAX_DISCORD_ARCHIVE_CHARACTERS - 40) {
      messages.push(
        `📜 **会話ログ（続き）**\n${rest.slice(0, MAX_DISCORD_ARCHIVE_CHARACTERS - 40)}`,
      );
      rest = rest.slice(MAX_DISCORD_ARCHIVE_CHARACTERS - 40);
    }
    current = `📜 **会話ログ（認識テキスト）**\n${rest}`;
  }
  if (current !== "📜 **会話ログ（認識テキスト）**") messages.push(current);
  return messages;
}

function findThread(collection, name) {
  const threads = collection?.threads ?? collection;
  return threads?.find?.((thread) => thread.name === name);
}

export function createDiscordTranscriptPublisher({
  textChannel,
  createMessagePayload,
  flushIntervalMs = 60_000,
  timeZone = DEFAULT_TIME_ZONE,
  scheduleInterval = setInterval,
  cancelInterval = clearInterval,
  logger = console,
}) {
  let pending = [];
  let flushing = Promise.resolve();
  const threads = new Map();
  const joinParticipants = createThreadParticipantJoiner();

  const resolveThread = async (date) => {
    if (threads.has(date)) return threads.get(date);
    const name = `会話ログ ${date}`;
    let thread;
    if (textChannel.threads) {
      thread = findThread(await textChannel.threads.fetchActive?.(), name);
      if (!thread && textChannel.threads.fetchArchived) {
        thread = findThread(
          await textChannel.threads.fetchArchived({
            type: "public",
            fetchAll: true,
          }),
          name,
        );
      }
      if (thread?.archived && typeof thread.setArchived === "function") {
        await thread.setArchived(false, "Continue the daily voice transcript");
      }
      if (!thread) {
        thread = await textChannel.threads.create({
          name,
          autoArchiveDuration: 1_440,
          reason: "Keep the complete recognized voice transcript by date",
        });
        await thread.send(
          createMessagePayload(
            "📚 認識後の発言を話者・時刻付きで追記します。生の音声ファイルは保存しません。",
          ),
        );
      }
    } else {
      const starter = await textChannel.send(
        createMessagePayload(`📚 **${name}**`),
      );
      thread = await starter.startThread({
        name,
        autoArchiveDuration: 1_440,
        reason: "Keep the complete recognized voice transcript by date",
      });
    }
    threads.set(date, thread);
    return thread;
  };

  const flush = () => {
    const operation = flushing.then(async () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      try {
        const grouped = Map.groupBy(batch, (statement) =>
          transcriptDateKey(statement.startedAt ?? Date.now(), timeZone),
        );
        for (const [date, statements] of grouped) {
          const thread = await resolveThread(date);
          await joinParticipants(
            thread,
            statements.map((statement) => statement.userId),
          );
          for (const content of formatDiscordTranscriptBatch(statements, {
            timeZone,
          })) {
            await thread.send(createMessagePayload(content));
          }
        }
      } catch (error) {
        pending = [...batch, ...pending];
        logger.error?.({
          component: "discord-voice",
          event: "meeting_transcript_discord_archive_failed",
          errorName: error?.name ?? "Error",
        });
      }
    });
    flushing = operation.catch(() => undefined);
    return operation;
  };

  const interval = scheduleInterval(() => void flush(), flushIntervalMs);
  interval?.unref?.();
  return {
    enqueue(statement) {
      pending.push(statement);
    },
    flush,
    async stop() {
      cancelInterval(interval);
      await flush();
    },
  };
}
