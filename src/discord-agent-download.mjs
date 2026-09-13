import { readFile, lstat } from "node:fs/promises";
import { dirname, resolve, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXTRA_FILES = [
  "package.json",
  "package-lock.json",
  "Start Agent.cmd",
  "scripts/start-agent-ui.ps1",
  "scripts/agent-worker-dpapi.ps1",
  "src/discord-agent-ui.html",
  "src/discord-agent-ui-client.js",
  "src/discord-agent-join.html",
  "src/discord-agent-join-client.js",
];

// Follow only literal relative module imports from the UI entry point. Never
// archive a directory, git tree, credentials, local configuration or runtime data.
export async function collectAgentClientFiles(root = ROOT) {
  root = resolve(root);
  const files = new Map();
  const pending = ["scripts/discord-agent-ui.mjs", ...EXTRA_FILES];
  while (pending.length) {
    const name = pending.pop();
    if (files.has(name)) continue;
    if (
      !/^(?:(?:src|scripts)\/[a-zA-Z0-9_./-]+\.(?:mjs|js|html|ps1)|package(?:-lock)?\.json|Start Agent\.cmd)$/.test(
        name,
      ) ||
      name.split("/").includes("..")
    )
      throw new Error("Unsafe client bundle path");
    const path = resolve(root, name);
    if (relative(root, path).startsWith(".."))
      throw new Error("Client path outside source root");
    // Reject links in every path component, not only the leaf.
    let current = root;
    for (const part of name.split("/")) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("Client bundle cannot contain symlinks");
    }
    const content = await readFile(path);
    if (content.length > 2 * 1024 * 1024)
      throw new Error("Client file is too large");
    files.set(name, content);
    if (!name.endsWith(".mjs")) continue;
    for (const match of content
      .toString("utf8")
      .matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g))
      pending.push(
        posix.normalize(
          posix.join(dirname(name).replaceAll("\\", "/"), match[1]),
        ),
      );
  }
  return [...files].sort(([a], [b]) => a.localeCompare(b));
}

export async function buildAgentDownload({ root = ROOT } = {}) {
  const files = await collectAgentClientFiles(root);
  const payload = gzipSync(
    Buffer.from(
      JSON.stringify(
        files.map(([name, bytes]) => ({
          name,
          data: bytes.toString("base64"),
        })),
      ),
    ),
  );
  const digest = createHash("sha256").update(payload).digest("hex");
  const template = await readFile(
    resolve(root, "scripts/agent-download-bootstrap.ps1"),
    "utf8",
  );
  const bootstrap = template.replaceAll("__PAYLOAD_SHA256__", digest);
  const attachment = Buffer.from(
    [
      "@echo off",
      "setlocal",
      'set "IDO_AGENT_SETUP_FILE=%~f0"',
      `powershell.exe -NoProfile -Command "$s=[IO.File]::ReadAllText($env:IDO_AGENT_SETUP_FILE); $parts=$s -split '(?m)^::IDO_BOOTSTRAP\\r?$',2; & ([scriptblock]::Create(($parts[1] -split '(?m)^::IDO_PAYLOAD:',2)[0]))"`,
      "exit /b %errorlevel%",
      "::IDO_BOOTSTRAP",
      bootstrap,
      `::IDO_PAYLOAD:${payload.toString("base64")}`,
      "",
    ].join("\r\n"),
  );
  if (attachment.length > 8 * 1024 * 1024)
    throw new Error("Client download exceeds attachment limit");
  return { attachment, name: "Connect-Agent.cmd" };
}
