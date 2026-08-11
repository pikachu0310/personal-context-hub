import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const startScriptPath = fileURLToPath(
  new URL("./start-traq-mcp.sh", import.meta.url),
);
const codexLaunch = process.argv.includes("--codex-launch");
const transport = new StdioClientTransport(
  codexLaunch
    ? {
        command: "wsl.exe",
        args: [
          "-d",
          process.env.PERSONAL_CONTEXT_WSL_DISTRO ?? "Ubuntu-24.04",
          "--",
          startScriptPath,
        ],
        stderr: "pipe",
      }
    : {
        command: process.execPath,
        args: [serverPath],
        stderr: "pipe",
      },
);
const client = new Client({ name: "personal-context-smoke", version: "0.1.0" });
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const whoami = await client.callTool({ name: "traq_whoami", arguments: {} });
  const text = whoami.content?.find((item) => item.type === "text")?.text;
  const profile = text ? JSON.parse(text) : undefined;
  console.log(
    JSON.stringify(
      {
        connected: true,
        toolCount: listed.tools.length,
        tools: listed.tools.map((tool) => tool.name),
        user: profile
          ? {
              id: profile.id,
              name: profile.name,
              displayName: profile.displayName,
            }
          : undefined,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
