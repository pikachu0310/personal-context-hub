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
