import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerCodex } from "../packages/common/dist/runtime/codex/app-server.mjs";
import { codexBinary } from "../packages/common/dist/runtime/codex/binary.js";
import { workerEnvironment } from "../packages/common/dist/runtime/platform.js";

const root = await mkdtemp(join(tmpdir(), "ido-preview-codex-"));
await mkdir(join(root, "codex"));
const codex = new AppServerCodex({
  codexPathOverride: codexBinary(),
  env: workerEnvironment(join(root, "codex")),
  experimentalApi: true,
});
try {
  const processId = "preview-smoke";
  let resolvePort;
  const portReady = new Promise((resolve) => {
    resolvePort = resolve;
  });
  let output = "";
  codex.on("notification", ({ method, params }) => {
    if (
      method === "command/exec/outputDelta" &&
      params.processId === processId
    ) {
      output += Buffer.from(params.deltaBase64, "base64").toString();
      const match = /PORT=(\d+)/.exec(output);
      if (match) resolvePort(Number(match[1]));
    }
  });
  const command = codex.request(
    "command/exec",
    {
      command: [
        process.execPath,
        "-e",
        "const s=require('http').createServer((q,r)=>r.end('preview'));s.listen(0,'127.0.0.1',()=>console.log('PORT='+s.address().port))",
      ],
      cwd: root,
      processId,
      streamStdoutStderr: true,
      disableTimeout: true,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [root],
        networkAccess: process.env.PREVIEW_SMOKE_NETWORK !== "0",
      },
    },
    null,
  );
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Codex server did not start: " + output)),
      20_000,
    );
  });
  const port = await Promise.race([
    portReady,
    command.then((value) => {
      throw new Error("Command exited: " + JSON.stringify(value));
    }),
    timeout,
  ]).finally(() => clearTimeout(timer));
  assert.equal(
    await (await fetch(`http://127.0.0.1:${port}`)).text(),
    "preview",
  );
  await codex.request("command/exec/terminate", { processId });
  await command;
  await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  console.log(
    "Pinned Codex command/exec smoke passed: sandboxed server, streaming output, explicit termination. No model turn or API credentials used.",
  );
} finally {
  await codex.close();
  await rm(root, { recursive: true, force: true });
}
