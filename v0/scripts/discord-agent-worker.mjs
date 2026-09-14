#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  DiscordAgentWorker,
  LocalCodexWorkerExecutor,
} from "../src/discord-agent-worker.mjs";
import {
  readAgentWorkerCredential,
  writeAgentWorkerCredential,
} from "../src/discord-agent-worker-credentials.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function stdin() {
  if (process.stdin.isTTY) return "";
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

const action = process.argv[2] ?? "start";
if (
  !process.argv.includes("--allow-automatic") &&
  process.env.PERSONAL_CONTEXT_AGENT_ALLOW_AUTOMATIC !== "true"
)
  throw new Error(
    "Use the browser UI for per-task consent, or explicitly opt into this repository's unattended execution with --allow-automatic.",
  );
if (!["pair", "start"].includes(action))
  throw new Error("Use 'pair' or 'start'.");
const workingDirectory = resolve(
  argument("--workdir") ??
    process.env.PERSONAL_CONTEXT_AGENT_WORKDIR ??
    process.cwd(),
);
const capabilities = String(
  argument("--capabilities") ??
    process.env.PERSONAL_CONTEXT_AGENT_CAPABILITIES ??
    "*",
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const maximumConcurrentTasks = Number(
  argument("--concurrency") ??
    process.env.PERSONAL_CONTEXT_AGENT_CONCURRENCY ??
    1,
);
let credential;
let pairingCode;
let gatewayUrl =
  argument("--gateway") ?? process.env.PERSONAL_CONTEXT_AGENT_GATEWAY_URL;
if (action === "pair") {
  pairingCode = argument("--code") ?? (await stdin());
  if (!pairingCode)
    throw new Error(
      "Pipe the one-time pairing code over stdin or pass it with --code.",
    );
  if (!gatewayUrl)
    throw new Error("Pass the Worker gateway URL with --gateway.");
} else {
  credential = await readAgentWorkerCredential();
  gatewayUrl ??= credential.gatewayUrl;
}
const executor = new LocalCodexWorkerExecutor({
  workingDirectory,
  workspaceDirectory: resolve(
    argument("--workspace-dir") ??
      process.env.PERSONAL_CONTEXT_AGENT_WORKSPACE_DIR ??
      join(
        homedir(),
        ".local",
        "state",
        "personal-context-hub",
        "agent-workspaces",
      ),
  ),
  model: argument("--model") ?? process.env.PERSONAL_CONTEXT_AGENT_MODEL,
  reasoningEffort:
    argument("--reasoning") ??
    process.env.PERSONAL_CONTEXT_AGENT_REASONING_EFFORT ??
    "medium",
  networkAccess: process.env.PERSONAL_CONTEXT_AGENT_ALLOW_NETWORK === "true",
});
const worker = new DiscordAgentWorker({
  gatewayUrl,
  credential,
  pairingCode,
  name: argument("--name") ?? process.env.PERSONAL_CONTEXT_AGENT_NAME,
  capabilities,
  maximumConcurrentTasks,
  executor,
  credentialWriter: writeAgentWorkerCredential,
});
const connected = await worker.connect();
console.log(
  JSON.stringify({
    connected: true,
    agentId: connected.agentId,
    gatewayUrl,
    workingDirectory,
    capabilities,
    credentialStored: true,
  }),
);
const shutdown = async () => {
  await worker.stop();
  process.exitCode = 0;
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
