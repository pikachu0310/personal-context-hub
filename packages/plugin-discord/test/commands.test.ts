import {
  ChannelType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Guild,
} from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  registerVoiceCommands,
  voiceCommandHandler,
} from "../src/commands/voice.js";
function interaction(
  command = "join",
  channelId: string | null = "voice",
  permitted = true,
  guildId = "guild",
) {
  const replies: string[] = [],
    calls: string[] = [];
  const channel = channelId
    ? {
        id: channelId,
        type: ChannelType.GuildVoice,
        permissionsFor: () => ({ has: () => permitted }),
      }
    : null;
  const value = {
    commandName: command,
    guildId,
    user: { id: "member" },
    guild: {
      members: {
        me: {},
        fetch: async () => {
          calls.push("member");
          return { voice: { channel } };
        },
      },
    },
    deferReply: async (options: any) => {
      assert.equal(options.flags, MessageFlags.Ephemeral);
      calls.push("defer");
    },
    editReply: async (options: any) => {
      assert.deepEqual(options.allowedMentions, { parse: [] });
      replies.push(options.content);
    },
  } as unknown as ChatInputCommandInteraction;
  return { value, replies, calls };
}
test("register join and leave individually without replacing unrelated commands", async () => {
  const names: string[] = [];
  await registerVoiceCommands({
    commands: { create: async (data: any) => names.push(data.name) },
  } as unknown as Guild);
  assert.deepEqual(names, ["join", "leave", "ido"]);
});
test("join acknowledges first and uses the invoking member's voice channel", async () => {
  const i = interaction();
  let joined = "";
  const handler = voiceCommandHandler(
    "guild",
    async (channel) => {
      joined = channel.id;
      i.calls.push("join");
    },
    () => {},
    () => undefined,
  );
  await handler(i.value);
  assert.deepEqual(i.calls, ["defer", "member", "join"]);
  assert.equal(joined, "voice");
  assert.match(i.replies[0], /参加しました/);
});
test("join reports absent voice channel, permissions, wrong guild and failed connection", async () => {
  let attempts = 0;
  const handler = voiceCommandHandler(
    "guild",
    async () => {
      attempts++;
      throw new Error("private detail");
    },
    () => {},
    () => undefined,
  );
  for (const [i, text] of [
    [interaction("join", null), /先に音声/],
    [interaction("join", "voice", false), /権限/],
    [interaction("join", "voice", true, "other"), /設定されたサーバー/],
  ] as const) {
    await handler(i.value);
    assert.match(i.replies[0], text);
  }
  assert.equal(attempts, 0);
  const i = interaction();
  await handler(i.value);
  assert.equal(attempts, 1);
  assert.match(i.replies[0], /操作に失敗/);
  assert.ok(!i.replies[0].includes("private detail"));
});
test("leave handles disconnected state, requires the same channel and stops once", async () => {
  let current: string | undefined,
    stops = 0;
  const handler = voiceCommandHandler(
    "guild",
    async () => {},
    () => {
      stops++;
      current = undefined;
    },
    () => current,
  );
  const idle = interaction("leave", null);
  await handler(idle.value);
  assert.match(idle.replies[0], /参加していません/);
  current = "voice";
  const other = interaction("leave", "other");
  await handler(other.value);
  assert.match(other.replies[0], /同じ音声/);
  assert.equal(stops, 0);
  const same = interaction("leave");
  await handler(same.value);
  assert.equal(stops, 1);
  assert.equal(current, undefined);
  assert.match(same.replies[0], /退出/);
});
test("overlapping commands acknowledge and report busy without opening duplicate connections", async () => {
  let resolve!: () => void;
  const joining = new Promise<void>((r) => {
    resolve = r;
  });
  const handler = voiceCommandHandler(
    "guild",
    () => joining,
    () => {},
    () => undefined,
  );
  const first = handler(interaction().value);
  await new Promise((r) => setImmediate(r));
  const second = interaction();
  await handler(second.value);
  assert.match(second.replies[0], /処理中/);
  resolve();
  await first;
});

test("ido quiet stops only playback; context routes to Engine and attaches full minutes", async () => {
  let stopped = 0;
  const events: any[] = [],
    results: any[] = [];
  const handler = voiceCommandHandler(
    "guild",
    async () => {},
    () => {
      throw new Error("must stay joined");
    },
    () => "voice",
    {
      textChannelId: "text",
      allowed: () => true,
      quiet: () => {
        stopped++;
      },
      request: async (event) => {
        events.push(event);
        return { content: "Summary", file: "Full minutes" };
      },
    },
  );
  const i = interaction("ido");
  Object.assign(i.value, {
    id: "interaction",
    channelId: "text",
    options: { getSubcommand: () => "quiet", getString: () => null },
  });
  await handler(i.value);
  assert.equal(stopped, 1);
  assert.equal(events.length, 0);
  Object.assign(i.value, {
    options: { getSubcommand: () => "context", getString: () => null },
    editReply: async (data: any) => results.push(data),
  });
  await handler(i.value);
  assert.equal(events[0].command, "context");
  assert.equal(results[0].files[0].attachment.toString(), "Full minutes");
  assert.deepEqual(results[0].allowedMentions, { parse: [] });
});

test("allowlist applies to slash controls and join, including users in the same voice channel", async () => {
  let called = false;
  const handler = voiceCommandHandler(
    "guild",
    async () => {
      called = true;
    },
    () => {},
    () => "voice",
    {
      textChannelId: "text",
      allowed: () => false,
      quiet: () => {
        called = true;
      },
      request: async () => {
        called = true;
        return { content: "" };
      },
    },
  );
  for (const command of ["join", "quiet", "context", "stop", "steer"]) {
    const i = interaction("ido");
    Object.assign(i.value, { options: { getSubcommand: () => command } });
    await handler(i.value);
    assert.match(i.replies[0], /受付対象ではありません/);
  }
  assert.equal(called, false);
});
