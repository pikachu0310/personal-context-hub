import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function sourcePath(name) {
  return fileURLToPath(new URL(`../src/${name}`, import.meta.url));
}

async function listTools(serverFile, env = {}) {
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [sourcePath(serverFile)],
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderr.push(chunk));
  const client = new Client({
    name: "personal-context-hub-contract-test",
    version: "0.1.0",
  });

  try {
    await client.connect(transport);
    return (await client.listTools()).tools;
  } catch (error) {
    const detail = Buffer.concat(stderr).toString("utf8").trim();
    if (detail) error.message = `${error.message}\nServer stderr: ${detail}`;
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function byName(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Missing MCP tool: ${name}`);
  return tool;
}

test("traQ MCP exposes guarded write and destructive contracts", async () => {
  const tools = await listTools("server.mjs", {
    PERSONAL_CONTEXT_TOKEN_PATH: "/definitely/missing/traq-token.json",
  });
  assert.equal(tools.length, 31);

  const post = byName(tools, "traq_post_message");
  assert.equal(post.annotations?.readOnlyHint, false);
  assert.ok(post.inputSchema.required.includes("confirmed"));

  const remove = byName(tools, "traq_delete_message");
  assert.equal(remove.annotations?.destructiveHint, true);
  assert.ok(remove.inputSchema.required.includes("confirmationMessageId"));
  assert.ok(remove.inputSchema.required.includes("confirmed"));

  const fallback = byName(tools, "traq_api_write");
  assert.equal(fallback.annotations?.destructiveHint, true);
  assert.equal(
    fallback.inputSchema.properties.confirmationPhrase.const,
    "ALLOW_TRAQ_WRITE",
  );
});

test("Discord Bot MCP exposes guarded writes without reading credentials at startup", async () => {
  const tools = await listTools("discord-server.mjs", {
    PERSONAL_CONTEXT_DISCORD_TOKEN_PATH:
      "/definitely/missing/discord-token.json",
  });
  assert.equal(tools.length, 20);

  const post = byName(tools, "discord_post_message");
  assert.equal(post.annotations?.readOnlyHint, false);
  assert.ok(post.inputSchema.required.includes("confirmed"));

  const remove = byName(tools, "discord_delete_message");
  assert.equal(remove.annotations?.destructiveHint, true);
  assert.ok(remove.inputSchema.required.includes("confirmationChannelId"));
  assert.ok(remove.inputSchema.required.includes("confirmationMessageId"));
  assert.ok(remove.inputSchema.required.includes("confirmed"));
});

test("Discord user MCP handshakes without Discord or credentials", async () => {
  const tools = await listTools("discord-rpc-server.mjs", {
    PERSONAL_CONTEXT_DISCORD_RPC_PATH: "/definitely/missing/discord-rpc.json",
  });
  assert.equal(tools.length, 8);
  assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
});

test("Thunderbird MCP exposes only read-only contracts", async () => {
  const tools = await listTools("thunderbird-mail-server.mjs", {
    THUNDERBIRD_PROFILE: "/definitely/missing/thunderbird-profile",
  });
  assert.equal(tools.length, 5);
  assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
  assert.ok(tools.every((tool) => tool.annotations?.openWorldHint === false));
});
