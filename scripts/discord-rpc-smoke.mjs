import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(
  new URL("../src/discord-rpc-server.mjs", import.meta.url),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
const client = new Client({
  name: "personal-context-discord-user-smoke",
  version: "0.1.0",
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const whoami = await client.callTool({
    name: "discord_user_whoami",
    arguments: {},
  });
  const guildsResult = await client.callTool({
    name: "discord_user_list_guilds",
    arguments: {},
  });
  const whoamiText = whoami.content?.find((item) => item.type === "text")?.text;
  const guildsText = guildsResult.content?.find(
    (item) => item.type === "text",
  )?.text;
  const profile = whoamiText ? JSON.parse(whoamiText) : undefined;
  const guilds = guildsText ? JSON.parse(guildsText) : undefined;
  console.log(
    JSON.stringify(
      {
        connected: true,
        toolCount: listed.tools.length,
        tools: listed.tools.map((tool) => tool.name),
        user: profile?.user
          ? {
              id: profile.user.id,
              username: profile.user.username,
              globalName: profile.user.global_name,
            }
          : undefined,
        accessibleGuildCount: Array.isArray(guilds) ? guilds.length : undefined,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
