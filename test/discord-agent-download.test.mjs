import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildAgentDownload,
  collectAgentClientFiles,
} from "../src/discord-agent-download.mjs";

test("download is self-contained, bounded, immutable and contains only client source files", async () => {
  const file = await buildAgentDownload();
  assert.equal(file.name, "Connect-Agent.cmd");
  const cmd = file.attachment.toString("utf8");
  const header = cmd.split("::IDO_BOOTSTRAP\r\n")[0];
  assert.ok(header.length < 8191);
  const packed = Buffer.from(
    cmd.match(/^::IDO_PAYLOAD:([A-Za-z0-9+/=]+)\r?$/m)[1],
    "base64",
  );
  assert.ok(cmd.includes(createHash("sha256").update(packed).digest("hex")));
  const files = JSON.parse(gunzipSync(packed));
  const names = files.map((f) => f.name);
  assert.ok(names.includes("scripts/agent-worker-dpapi.ps1"));
  assert.ok(names.includes("src/discord-agent-ui.mjs"));
  assert.ok(names.includes("src/discord-agent-join-client.js"));
  assert.ok(names.includes("package-lock.json"));
  assert.equal(
    names.some(
      (n) =>
        n.includes("..") ||
        /\.env|\.git|credentials\/|\.codex|runtime\/discord|meeting-live|auth\.json|\.dpapi|node_modules/.test(
          n,
        ),
    ),
    false,
  );
  assert.deepEqual(
    names,
    (await collectAgentClientFiles()).map(([n]) => n),
  );
  assert.ok(file.attachment.length < 8 * 1024 * 1024);
});

test(
  "Windows download expands the verified client and launches its entry point",
  { skip: process.platform !== "win32" },
  async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), "ido-download-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const source = join(fixture, "source");
    await mkdir(join(source, "scripts"), { recursive: true });
    await mkdir(join(source, "src"), { recursive: true });
    for (const [name] of await collectAgentClientFiles()) {
      const path = join(source, name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, name.endsWith(".json") ? "{}" : "");
    }
    await writeFile(
      join(source, "scripts/agent-download-bootstrap.ps1"),
      await readFile(
        new URL("../scripts/agent-download-bootstrap.ps1", import.meta.url),
      ),
    );
    await writeFile(
      join(source, "scripts/start-agent-ui.ps1"),
      "[IO.File]::WriteAllText((Join-Path $env:LOCALAPPDATA 'started.txt'), $env:IDO_AGENT_PROJECT_DIRECTORY)",
    );
    const download = await buildAgentDownload({ root: source });
    const launcher = join(fixture, download.name);
    await writeFile(launcher, download.attachment);
    await promisify(execFile)("cmd.exe", ["/d", "/c", launcher], {
      env: { ...process.env, LOCALAPPDATA: fixture },
      timeout: 15000,
      windowsHide: true,
    });
    const installed = await readFile(join(fixture, "started.txt"), "utf8");
    assert.ok(
      installed.startsWith(
        join(fixture, "personal-context-hub", "agent-client"),
      ),
    );
    assert.equal(await readFile(join(installed, "package.json"), "utf8"), "{}");
  },
);
