import assert from "node:assert/strict";
import test from "node:test";
import type { Interaction } from "discord.js";
import { handleProjectInteraction } from "../src/commands/project.js";
import type { DiscordState } from "../src/runtime/state.js";

function fixture(count = 2) {
  const projects = Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    name: i === 0 ? "デフォルト" : `Project ${i}`,
    remote: "",
  }));
  const calls: Array<string | undefined> = [];
  const state = {
    config: { guildId: "guild" },
    projectCommand: async (_subject, selection) => {
      calls.push(selection);
      if (selection && !projects.some((p) => p.id === selection))
        throw new Error("PROJECT_NOT_FOUND");
      return { projects, projectId: selection ?? "p0" };
    },
  } as Pick<DiscordState, "config" | "projectCommand">;
  return { state, calls };
}
function interaction(
  kind: "command" | "autocomplete" | "select" | "button",
  input = "",
) {
  const replies: any[] = [];
  const value = {
    commandName: "project",
    guildId: "guild",
    user: { id: "123" },
    customId:
      kind === "button" ? `ido-project:page:${input}` : "ido-project:select",
    values: [input],
    options: { getFocused: () => input, getString: () => input || null },
    isChatInputCommand: () => kind === "command",
    isAutocomplete: () => kind === "autocomplete",
    isStringSelectMenu: () => kind === "select",
    isButton: () => kind === "button",
    deferReply: async () => {},
    deferUpdate: async () => {},
    respond: async (data: any) => replies.push(data),
    editReply: async (data: any) => replies.push(data),
    reply: async (data: any) => replies.push(data),
  } as unknown as Interaction;
  return { value, replies };
}

test("bare /project offers current project and every page; selection switches by ID", async () => {
  const { state, calls } = fixture(27);
  const command = interaction("command");
  await handleProjectInteraction(state, command.value);
  const reply = command.replies[0];
  assert.match(reply.content, /デフォルト/);
  assert.equal(reply.components[0].toJSON().components[0].options.length, 25);
  assert.equal(
    reply.components[0].toJSON().components[0].options[0].default,
    true,
  );
  assert.deepEqual(reply.allowedMentions, { parse: [] });
  const next = interaction("button", "1");
  await handleProjectInteraction(state, next.value);
  assert.deepEqual(
    next.replies[0].components[0]
      .toJSON()
      .components[0].options.map((p: any) => p.value),
    ["p25", "p26"],
  );
  assert.equal(
    next.replies[0].components[1].toJSON().components[1].disabled,
    true,
  );
  const select = interaction("select", "p26");
  await handleProjectInteraction(state, select.value);
  assert.match(select.replies[0].content, /現在のプロジェクト: Project 26/);
  assert.deepEqual(calls, [undefined, undefined, "p26"]);
});

test("autocomplete shows candidates before typing and normalizes name and ID searches", async () => {
  const { state } = fixture(27);
  for (const [query, expected] of [
    ["", 25],
    ["ＰＲＯＪＥＣＴ ２６", 1],
    ["P26", 1],
    ["missing", 0],
  ] as const) {
    const i = interaction("autocomplete", query);
    await handleProjectInteraction(state, i.value);
    assert.equal(i.replies[0].length, expected);
    if (expected === 1) assert.equal(i.replies[0][0].value, "p26");
  }
});

test("project interactions recheck guild and user policies and reject stale selections", async () => {
  const { state, calls } = fixture();
  for (const kind of ["command", "autocomplete", "select", "button"] as const) {
    const i = interaction(kind, "p1");
    Object.assign(i.value, { guildId: "other" });
    await handleProjectInteraction(state, i.value);
    assert.equal(calls.length, 0);
    if (kind === "autocomplete") assert.deepEqual(i.replies[0], []);
    else assert.match(i.replies[0].content, /権限/);
  }
  state.config.userPolicy = "allowlist";
  const denied = interaction("select", "p1");
  await handleProjectInteraction(state, denied.value);
  assert.equal(calls.length, 0);
  state.config.allowedUserIds = "123";
  const stale = interaction("select", "deleted");
  await handleProjectInteraction(state, stale.value);
  assert.match(stale.replies[0].content, /最新の候補/);
  assert.deepEqual(stale.replies[0].components, []);
});
