import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(
  new URL("../src/thunderbird-mail-server.mjs", import.meta.url),
);
const startScriptPath = fileURLToPath(
  new URL("./start-thunderbird-mail-mcp.sh", import.meta.url),
);
const codexLaunch = process.argv.includes("--codex-launch");
const wslArgs = [
  "-d",
  process.env.PERSONAL_CONTEXT_WSL_DISTRO ?? "Ubuntu-24.04",
  "--",
];
if (process.env.THUNDERBIRD_PROFILE) {
  wslArgs.push(
    "/usr/bin/env",
    `THUNDERBIRD_PROFILE=${process.env.THUNDERBIRD_PROFILE}`,
  );
}
wslArgs.push(startScriptPath);
const transport = new StdioClientTransport(
  codexLaunch
    ? {
        command: "wsl.exe",
        args: wslArgs,
        stderr: "pipe",
      }
    : {
        command: process.execPath,
        args: [serverPath],
        stderr: "pipe",
      },
);
const client = new Client({
  name: "personal-context-thunderbird-mail-smoke",
  version: "0.1.0",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));

function parseResult(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const status = parseResult(
    await client.callTool({
      name: "thunderbird_profile_status",
      arguments: {},
    }),
  );
  const accounts = parseResult(
    await client.callTool({
      name: "thunderbird_list_accounts",
      arguments: {},
    }),
  );
  console.log(
    JSON.stringify(
      {
        connected: true,
        readOnly: status?.readOnly,
        databaseUpdatedAt: status?.databaseUpdatedAt,
        toolCount: listed.tools.length,
        tools: listed.tools.map((tool) => tool.name),
        accounts: Array.isArray(accounts)
          ? accounts.map(({ email, indexedMessages, newestIndexedAt }) => ({
              email,
              indexedMessages,
              newestIndexedAt,
            }))
          : [],
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
