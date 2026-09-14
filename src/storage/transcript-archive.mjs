import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_TIME_ZONE,
  transcriptDateKey,
  speakerName,
} from "./transcript-format.mjs";
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
      utteranceId: statement.utteranceId,
      segmentIndex: statement.segmentIndex,
      guildId,
      voiceChannelId,
      textChannelId,
      userId: statement.userId,
      speakerName: speakerName(statement),
      text: String(statement.text ?? ""),
      role: statement.role ?? "user",
      ...(statement.provider ? { provider: statement.provider } : {}),
      ...(statement.sourceSequences
        ? { sourceSequences: statement.sourceSequences }
        : {}),
      ...(statement.sourceStartMs !== undefined
        ? {
            sourceStartMs: statement.sourceStartMs,
            sourceEndMs: statement.sourceEndMs,
          }
        : {}),
      ...(statement.final !== undefined ? { final: statement.final } : {}),
      ...(statement.playbackStatus
        ? { playbackStatus: statement.playbackStatus }
        : {}),
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
