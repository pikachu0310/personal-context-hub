import assert from "node:assert/strict";
import test from "node:test";
import {
  createDiscordTaskThread,
  formatDiscordTaskCard,
} from "../src/discord-voice-server.mjs";
import { createIdobataMessageHandler } from "../src/discord-voice-commands.mjs";

test("an assigned Issue gets one Forum thread and agent-channel notice", async () => {
  const edits = [];
  const replies = [];
  const notices = [];
  let created;
  const starter = {
    id: "forum-thread",
    edit: async (payload) => {
      edits.push(payload);
      return starter;
    },
  };
  const thread = {
    id: "forum-thread",
    fetchStarterMessage: async () => starter,
    send: async (payload) => {
      replies.push(payload);
      return { id: `reply-${replies.length}` };
    },
  };
  const issueForum = {
    threads: {
      create: async (options) => {
        created = options;
        return thread;
      },
    },
  };
  const channel = (id) => ({
    id,
    send: async (payload) => {
      notices.push({ id, payload });
      return { id: `${id}-${notices.length}` };
    },
  });
  const textChannel = {
    send: async () => assert.fail("Forum mode must not create a text starter"),
  };
  const task = {
    id: "issue-1",
    issueId: "issue-1",
    title: "UIを修正",
    request: "ボタンを直して",
    assignedAgentId: "frontend",
    assignedAgentName: "Frontend Codex",
    assignmentReason: "UI担当",
    createdAt: 1,
    checkpoint: async () => undefined,
  };
  const surface = await createDiscordTaskThread(textChannel, {
    issueForum,
    coordinationChannel: channel("coordination"),
    agentChannels: new Map([["frontend", channel("frontend-channel")]]),
  })(task);

  assert.match(created.name, /issue-1 UIを修正/);
  assert.match(created.message.content, /Frontend Codex/);
  assert.equal(surface.threadId, "forum-thread");
  assert.equal(surface.surfaceType, "forum");
  assert.equal(task.surfaceType, "forum");
  assert.ok(edits.some(({ content }) => /状態: \*\*待機中\*\*/.test(content)));
  assert.ok(replies.some(({ content }) => /依頼内容/.test(content)));
  assert.equal(notices.length, 2);
  assert.ok(
    notices.every(({ payload }) => /Issue `issue-1`/.test(payload.content)),
  );
});

test("Issue cards show the assigned Codex agent and assignment reason", () => {
  const card = formatDiscordTaskCard({
    id: "abc123",
    issueId: "abc123",
    title: "API修正",
    assignedAgentId: "backend",
    assignedAgentName: "Backend Codex",
    assignmentReason: "apiが担当領域に一致",
  });
  assert.match(card, /Codexタスク Issue\*\* `abc123`/);
  assert.match(card, /担当エージェント: \*\*Backend Codex\*\*/);
  assert.match(card, /apiが担当領域に一致/);
});

test("a lost Forum creation acknowledgement recovers the existing Issue thread", async () => {
  const starter = {
    id: "recovered-thread",
    edit: async () => starter,
  };
  const recovered = {
    id: "recovered-thread",
    parentId: "forum-id",
    name: "lost-issue 復旧テスト",
    fetchStarterMessage: async () => starter,
    send: async () => ({ id: "reply" }),
  };
  const issueForum = {
    id: "forum-id",
    threads: {
      create: async () => {
        throw new Error("acknowledgement lost");
      },
      fetchActive: async () => ({
        threads: new Map([[recovered.id, recovered]]),
      }),
      fetchArchived: async () => ({ threads: new Map() }),
    },
  };
  const surface = await createDiscordTaskThread(
    { send: async () => assert.fail("must stay in the Forum") },
    { issueForum },
  )({
    id: "lost-issue",
    title: "復旧テスト",
    request: "重複させない",
    assignedAgentId: "agent",
    assignedAgentName: "Agent",
    createdAt: 1,
  });
  assert.equal(surface.threadId, "recovered-thread");
});

test("the coordination channel reports connected agents and assigned Issues", async () => {
  const replies = [];
  const handler = createIdobataMessageHandler({
    config: {
      guildId: "guild",
      textChannelId: "meeting",
      agentCoordinationChannelId: "coordination",
      allowedUserId: "owner",
      codexAgents: [],
    },
    session: {},
    taskQueue: {
      agentTeam: {
        list: () => [
          {
            id: "frontend",
            name: "Frontend Codex",
            capabilities: ["ui", "react"],
            maximumConcurrentTasks: 2,
          },
        ],
      },
      list: () => [
        {
          id: "issue-1",
          issueId: "issue-1",
          assignedAgentId: "frontend",
          state: "running",
        },
      ],
    },
  });
  await handler({
    id: "message",
    guildId: "guild",
    channelId: "coordination",
    author: { id: "member", bot: false },
    content: "/ido agents",
    channel: { send: async (payload) => replies.push(payload) },
  });
  assert.match(replies[0].content, /Frontend Codex/);
  assert.match(replies[0].content, /稼働 1\/2/);
  assert.match(replies[0].content, /Issue累計 1件/);
});
