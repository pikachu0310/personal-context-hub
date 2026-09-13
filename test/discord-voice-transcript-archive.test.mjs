import assert from "node:assert/strict";
import test from "node:test";
import {
  createDiscordTranscriptPublisher,
  formatDiscordTranscriptBatch,
} from "../src/adapters/discord/transcript-publisher.mjs";
import {
  createLocalTranscriptArchive,
  createMeetingTranscriptArchive,
} from "../src/storage/transcript-archive.mjs";
import { transcriptDateKey } from "../src/storage/transcript-format.mjs";

const statement = {
  id: "statement-1",
  sequence: 1,
  userId: "user-1",
  speakerName: "Alice",
  startedAt: Date.parse("2026-08-29T00:01:02.000Z"),
  text: "最初の発言\n続き",
};

test("local transcript archive appends exact recognized text as private JSONL", async () => {
  const directories = [];
  const writes = [];
  const archive = createLocalTranscriptArchive({
    directory: "/private/transcripts",
    guildId: "guild-1",
    voiceChannelId: "voice-1",
    textChannelId: "text-1",
    makeDirectory: async (...args) => directories.push(args),
    append: async (...args) => writes.push(args),
  });

  const result = await archive.append(statement);
  await archive.flush();

  assert.equal(transcriptDateKey(statement.startedAt), "2026-08-29");
  assert.equal(directories[0][0], "/private/transcripts/guild-1");
  assert.equal(directories[0][1].mode, 0o700);
  assert.equal(writes[0][0], "/private/transcripts/guild-1/2026-08-29.jsonl");
  assert.equal(writes[0][2].mode, 0o600);
  const record = JSON.parse(writes[0][1]);
  assert.equal(record.text, "最初の発言\n続き");
  assert.equal(record.speakerName, "Alice");
  assert.equal(record.userId, "user-1");
  assert.equal(record.id, "statement-1");
  assert.equal(result.file, writes[0][0]);
});

test("Discord transcript publisher batches statements into one silent daily thread", async () => {
  const threadPosts = [];
  const created = [];
  let intervalCallback;
  let cancelled = false;
  const thread = {
    name: "会話ログ 2026-08-29",
    send: async (payload) => threadPosts.push(payload),
  };
  const publisher = createDiscordTranscriptPublisher({
    textChannel: {
      threads: {
        fetchActive: async () => ({ threads: [] }),
        fetchArchived: async () => ({ threads: [] }),
        create: async (options) => {
          created.push(options);
          return thread;
        },
      },
    },
    createMessagePayload: (content) => ({ content, silent: true }),
    scheduleInterval: (callback, delay) => {
      assert.equal(delay, 60_000);
      intervalCallback = callback;
      return { unref: () => undefined };
    },
    cancelInterval: () => {
      cancelled = true;
    },
    logger: { error: () => undefined },
  });

  publisher.enqueue(statement);
  intervalCallback();
  await publisher.flush();
  await publisher.stop();

  assert.equal(created.length, 1);
  assert.equal(created[0].name, "会話ログ 2026-08-29");
  assert.equal(created[0].autoArchiveDuration, 1_440);
  assert.equal(threadPosts.length, 2);
  assert.ok(threadPosts.every(({ silent }) => silent));
  assert.match(threadPosts[1].content, /09:01:02.*Alice.*最初の発言/);
  assert.match(threadPosts[1].content, /↳ 続き/);
  assert.equal(cancelled, true);
});

test("Discord transcript formatting stays within the message limit", () => {
  const messages = formatDiscordTranscriptBatch([
    { ...statement, text: "あ".repeat(4_000) },
  ]);
  assert.ok(messages.length > 1);
  assert.ok(messages.every((message) => message.length <= 1_850));
});

test("meeting archive never publishes a statement before local persistence", async () => {
  let published = false;
  const archive = createMeetingTranscriptArchive({
    localArchive: {
      append: async () => {
        throw new Error("disk full");
      },
      flush: async () => undefined,
    },
    discordPublisher: {
      enqueue: () => {
        published = true;
      },
      stop: async () => undefined,
    },
  });

  await assert.rejects(() => archive.append(statement), /disk full/);
  assert.equal(published, false);
});
