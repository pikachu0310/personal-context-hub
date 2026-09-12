import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_TIME_ZONE = "Asia/Tokyo";
const MAX_DISCORD_ARCHIVE_CHARACTERS = 1_850;

function dateParts(timestamp, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function transcriptDateKey(timestamp, timeZone = DEFAULT_TIME_ZONE) {
  const { year, month, day } = dateParts(timestamp, timeZone);
  return `${year}-${month}-${day}`;
}

function transcriptTime(timestamp, timeZone = DEFAULT_TIME_ZONE) {
  const { hour, minute, second } = dateParts(timestamp, timeZone);
  return `${hour}:${minute}:${second}`;
}

function speakerName(statement) {
  return String(statement.speakerName ?? statement.userId ?? "不明な話者")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 80);
}

function escapeDiscordMarkdown(value) {
  return String(value ?? "").replace(/([\\`*_{}[\]()#+.!|>~-])/g, "\\$1");
}

export function createLocalTranscriptArchive({
  directory,
  guildId,
  voiceChannelId,
  textChannelId,
  timeZone = DEFAULT_TIME_ZONE,
  makeDirectory = mkdir,
  append = appendFile,
}) {
  if (!directory)
    throw new TypeError("transcript archive directory is required");
  let writes = Promise.resolve();

  const appendStatement = (statement) => {
    const startedAt = statement.startedAt ?? Date.now();
    const record = {
      schemaVersion: 1,
      id: statement.id,
      meetingId: statement.meetingId,
      recordedAt: new Date().toISOString(),
      startedAt: new Date(startedAt).toISOString(),
      sequence: statement.sequence,
      guildId,
      voiceChannelId,
      textChannelId,
      userId: statement.userId,
      speakerName: speakerName(statement),
      text: String(statement.text ?? ""),
    };
    const file = join(
      directory,
      String(guildId ?? "unknown-guild"),
      `${transcriptDateKey(startedAt, timeZone)}.jsonl`,
    );
    const operation = writes.then(async () => {
      await makeDirectory(join(directory, String(guildId ?? "unknown-guild")), {
        recursive: true,
        mode: 0o700,
      });
      await append(file, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "a",
        mode: 0o600,
      });
      return { file, record };
    });
    writes = operation.catch(() => undefined);
    return operation;
  };

  return {
    append: appendStatement,
    flush: () => writes,
  };
}

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

export function createMeetingTranscriptArchive({
  localArchive,
  discordPublisher,
}) {
  return {
    async append(statement) {
      await localArchive.append(statement);
      discordPublisher?.enqueue(statement);
    },
    async stop() {
      await localArchive.flush();
      await discordPublisher?.stop?.();
    },
  };
}
