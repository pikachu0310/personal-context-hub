import assert from "node:assert/strict";
import test from "node:test";
import { Publications } from "../src/output/publications.js";

test("concurrent transcript updates edit one card and reuse its ID after restart", async () => {
  const sent: any[] = [],
    edited: any[] = [],
    saved: any[] = [];
  const channel = {
    isTextBased: () => true,
    send: async (p: any) => {
      sent.push(p);
      return { id: "123" };
    },
    messages: {
      edit: async (id: string, p: any) => {
        edited.push([id, p]);
      },
    },
  };
  const publisher = new Publications(
    async () => channel,
    (...a) => {
      saved.push(a);
    },
  );
  await Promise.all([
    publisher.update("transcript", "channel", "speaker one"),
    publisher.update("transcript", "channel", "speaker one\nspeaker two"),
  ]);
  assert.equal(sent.length, 1);
  assert.equal(edited.length, 1);
  assert.deepEqual(edited[0][1].allowedMentions, { parse: [] });
  assert.deepEqual(saved, [["transcript", "123"]]);
  await new Publications(
    async () => channel,
    () => {},
  ).update("transcript", "channel", "next", "123");
  assert.equal(sent.length, 1);
  assert.equal(edited.length, 2);
});
test("deleted cards are replaced, network failures do not create duplicate messages", async () => {
  let sent = 0,
    code = 500;
  const channel = {
    isTextBased: () => true,
    send: async () => {
      sent++;
      return { id: "456" };
    },
    messages: {
      edit: async () => {
        throw { code };
      },
    },
  };
  const publisher = new Publications(
    async () => channel,
    () => {},
  );
  await assert.rejects(publisher.update("key", "channel", "text", "123"));
  assert.equal(sent, 0);
  code = 10008;
  await publisher.update("key", "channel", "text", "123");
  assert.equal(sent, 1);
});

test("publication queued before a configuration change cannot edit or send afterwards", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let current = true,
    sends = 0,
    edits = 0;
  const publisher = new Publications(
    async () => {
      await gate;
      return {
        isTextBased: () => true,
        send: async () => {
          sends++;
          return { id: "1" };
        },
        messages: {
          edit: async () => {
            edits++;
          },
        },
      };
    },
    () => {},
  );
  const pending = publisher.update(
    "key",
    "channel",
    "old configuration",
    "existing",
    () => current,
  );
  current = false;
  release();
  await pending;
  assert.equal(sends, 0);
  assert.equal(edits, 0);
});

test("current transcript shows project names before speech, reuses the card on switching, and fences a stale snapshot", async () => {
  const { ConversationPublications } =
    await import("../src/output/conversation.js");
  const sent: any[] = [],
    edits: any[] = [];
  const saved = new Map();
  const channel = {
    isTextBased: () => true,
    send: async (payload: any) => {
      sent.push(payload);
      return { id: "card" };
    },
    messages: {
      edit: async (_id: string, payload: any) => edits.push(payload),
    },
  };
  const state: any = {
    config: { projectId: "default", textChannelId: "channel" },
    speechEpoch: 0,
    client: { isReady: () => true },
  };
  let snapshot: any = {
    project: { id: "default", name: "デフォルト" },
    meeting: {
      id: "one",
      projectId: "default",
      summary: "",
      messages: [{ text: " \t\n　", authorId: "blank-speaker", at: 0 }],
    },
  };
  let pending: Promise<any> | undefined;
  const rpc: any = {
    request: async (operation: string, input: any) =>
      operation === "projects.current"
        ? (pending ?? structuredClone(snapshot))
        : saved.get(input.key),
  };
  const publisher = new Publications(
    async () => channel,
    (key, messageId) => {
      saved.set(key, { messageId });
    },
  );
  const conversation = new ConversationPublications(
    state,
    () => rpc,
    publisher,
  );
  await conversation.refresh();
  assert.match(sent[0].content, /現在のプロジェクト: デフォルト/);
  assert.doesNotMatch(sent[0].content, /blank-speaker/);
  state.config.projectId = "next";
  state.speechEpoch++;
  snapshot = {
    project: { id: "next", name: "開発" },
    meeting: {
      id: "two",
      projectId: "next",
      summary: "",
      messages: [
        { text: "はい", authorId: "speaker", at: 0 },
        { text: "", authorId: "blank-speaker", at: 0 },
      ],
    },
  };
  await conversation.refresh();
  assert.equal(sent.length, 1);
  assert.match(edits[0].content, /現在のプロジェクト: 開発/);
  assert.match(edits[0].content, /speaker: はい/);
  assert.doesNotMatch(edits[0].content, /blank-speaker/);
  await conversation.publish({
    type: "transcript",
    meetingId: "one",
    data: {
      projectId: "default",
      projectName: "デフォルト",
      messages: [{ text: "stale", authorId: "user", at: 0 }],
    },
  });
  assert.equal(edits.length, 1);
  let release!: (value: any) => void;
  pending = new Promise((resolve) => {
    release = resolve;
  });
  const stale = conversation.refresh();
  state.speechEpoch++;
  state.config.projectId = "default";
  release(snapshot);
  await stale;
  assert.equal(edits.length, 1);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test("transcripts select the latest twelve nonblank statements before formatting speaker rows", async () => {
  const { renderPublication } = await import("../src/output/render.js");
  const messages = [
    ...Array.from({ length: 14 }, (_, index) => ({
      authorId: `speaker-${index}`,
      at: 0,
      text: `発言${index}`,
    })),
    ...Array.from({ length: 14 }, (_, index) => ({
      authorId: `blank-${index}`,
      at: 0,
      text: ["", " ", "　", "\t", "\r\n", " \t　\n"][index % 6],
      stage: ["transcribing", "ignored", "failed"][index % 3],
    })),
  ];
  const content = renderPublication({
    type: "transcript",
    meetingId: "m",
    data: { projectId: "p", messages },
  });
  const rows = content.split("\n\n")[1].split("\n");
  assert.equal(rows.length, 12);
  assert.doesNotMatch(content, /blank-|speaker-[01]:/);
  for (let index = 2; index < 14; index++)
    assert.ok(rows[index - 2].endsWith(`speaker-${index}: 発言${index}`));
  const short = renderPublication({
    type: "transcript",
    meetingId: "m",
    data: { messages: [{ authorId: "speaker", at: 0, text: " はい　" }] },
  });
  assert.ok(short.endsWith("speaker:  はい　"));
});

test("transcript headers remain visible with long logs and line breaks in project names", async () => {
  const { renderPublication } = await import("../src/output/render.js");
  const content = renderPublication({
    type: "transcript",
    meetingId: "m",
    data: {
      projectId: "p",
      projectName: "開発\n@everyone",
      messages: [{ authorId: "user", at: 0, text: "長い発言".repeat(1000) }],
    },
  });
  assert.match(content, /現在のプロジェクト: 開発 @everyone/);
  assert.ok(content.length < 1900);
});

test("Discord publication errors preserve safe actionable codes across RPC", async () => {
  for (const [code, expected] of [
    [50013, "DISCORD_MISSING_PERMISSIONS"],
    [50001, "DISCORD_MISSING_ACCESS"],
    [10003, "DISCORD_UNKNOWN_CHANNEL"],
    [50005, "DISCORD_CANNOT_EDIT_MESSAGE"],
    [50035, "DISCORD_INVALID_MESSAGE"],
    ["ECONNRESET", "ECONNRESET"],
  ] as const) {
    const publisher = new Publications(
      async () => {
        throw Object.assign(new Error("private message and credential"), {
          code,
        });
      },
      () => {},
    );
    await assert.rejects(
      publisher.update("key", "channel", "text"),
      (error: Error) => {
        assert.equal(error.message, expected);
        assert.doesNotMatch(error.message, /private|credential/);
        return true;
      },
    );
  }
});

test("transient connection failures retry channel reads and existing edits once without sending", async () => {
  let reads = 0,
    edits = 0,
    sends = 0;
  const failure = () =>
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("private endpoint"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
  const publisher = new Publications(
    async () => {
      if (++reads === 1) throw failure();
      return {
        isTextBased: () => true,
        send: async () => {
          sends++;
          return { id: "unexpected" };
        },
        messages: {
          edit: async () => {
            if (++edits === 1) throw failure();
          },
        },
      };
    },
    () => {},
  );
  await publisher.update("key", "channel", "updated", "existing");
  assert.equal(reads, 2);
  assert.equal(edits, 2);
  assert.equal(sends, 0);
});

test("persistent connection failure stops after one retry and keeps the original cause", async () => {
  let reads = 0;
  const publisher = new Publications(
    async () => {
      reads++;
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("private endpoint"), {
          code: "UND_ERR_CONNECT_TIMEOUT",
        }),
      });
    },
    () => {},
  );
  await assert.rejects(
    publisher.update("key", "channel", "text"),
    /UND_ERR_CONNECT_TIMEOUT/,
  );
  assert.equal(reads, 2);
});

test("configuration changes during a connection failure cancel the pending retry", async () => {
  let current = true,
    reads = 0;
  const publisher = new Publications(
    async () => {
      reads++;
      current = false;
      throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    },
    () => {},
  );
  await publisher.update("key", "channel", "text", undefined, () => current);
  assert.equal(reads, 1);
});

test("an uncertain new-message send is not retried or replaced", async () => {
  let sends = 0,
    saves = 0;
  const publisher = new Publications(
    async () => ({
      isTextBased: () => true,
      send: async () => {
        sends++;
        throw Object.assign(new Error("connection lost after send"), {
          code: "ECONNRESET",
        });
      },
    }),
    () => {
      saves++;
    },
  );
  await assert.rejects(
    publisher.update("key", "channel", "text"),
    /ECONNRESET/,
  );
  assert.equal(sends, 1);
  assert.equal(saves, 0);
});
