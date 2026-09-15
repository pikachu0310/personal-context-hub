import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "../src/bootstrap/client.js";
import { git } from "../src/preview/repository.js";
import type { Implementation } from "@ido/common/contracts/api";
import type { AppServerCodex } from "../src/codex/app-server.mjs";

export async function previewFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ido-preview-session-"));
  const source = join(directory, "source");
  await mkdir(source);
  await git(["init", "-b", "main", source]);
  await git(["-C", source, "config", "user.name", "Fixture"]);
  await git(["-C", source, "config", "user.email", "fixture@example.invalid"]);
  await writeFile(
    join(source, "server.cjs"),
    `const http = require('http'); const fs = require('fs');
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); if(req.url === '/blocked') res.setHeader('x-frame-options', 'DENY'); res.end(fs.readFileSync('index.html')); });
server.listen(Number(process.argv[2]), '127.0.0.1');`,
  );
  const artifacts: Implementation[] = [];
  for (const [id, color] of [
    ["a", "#e6f4f1"],
    ["b", "#e8ecff"],
  ]) {
    await writeFile(
      join(source, "index.html"),
      `<!doctype html><meta charset="utf-8"><style>body{font:24px system-ui;background:${color};padding:40px}button{font:inherit;padding:12px}</style><h1>案${id.toUpperCase()} — 検索画面</h1><p>表示と操作を確認できます</p><button onclick="this.textContent='操作できました'">試す</button>`,
    );
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "commit.gpgsign=false", "commit", "-m", id]);
    artifacts.push({
      id,
      projectId: "p",
      taskId: id,
      runId: id,
      revision: 1,
      title: `検索画面・案${id.toUpperCase()}`,
      remote: "https://example.com/team/repo.git",
      branch: "refs/heads/main",
      commit: await git(["-C", source, "rev-parse", "HEAD"]),
      createdAt: 1,
    });
  }
  const client = new Client(
    join(directory, "client"),
    new URL("../dist/ui", import.meta.url).pathname,
  );
  client.credentials.backend = "file";
  Object.defineProperty(client, "checkAccount", { value: async () => {} });
  await client.start(0);
  client.connected = true;
  client.implementations.supported = true;
  client.settings.engineUrl = "https://engine.example.invalid";
  client.settings.projects = [
    {
      id: "p",
      name: "画面の比較",
      remote: "https://example.com/team/repo.git",
    },
  ];
  client.settings.slots = 1;
  client.localPreviews.repositories.prepare = async (
    artifact,
    target,
    _mapping,
    signal,
  ) => {
    await mkdir(join(target, ".."), { recursive: true });
    try {
      await git(["-C", target, "rev-parse", "HEAD"], signal);
    } catch {
      await git(
        ["-C", source, "worktree", "add", "--detach", target, artifact.commit],
        signal,
      );
    }
    return source;
  };
  client.workspaceRequest = async <T>(
    operation: string,
    input: Record<string, unknown>,
  ): Promise<T> => {
    if (input.projectId !== "p") throw new Error("PROJECT_INVITATION_REQUIRED");
    if (operation === "implementations.read") {
      const values = (input.implementationIds as string[]).map((id) =>
        artifacts.find((a) => a.id === id),
      );
      if (values.some((v) => !v)) throw new Error("IMPLEMENTATION_NOT_FOUND");
      return values as T;
    }
    if (operation === "implementations.list")
      return artifacts.map((a) => ({
        taskId: a.taskId,
        title: a.title,
        availability: "ready",
        implementation: a,
      })) as T;
    throw new Error("UNSUPPORTED_OPERATION");
  };
  const launches: Array<{ command: string[]; policy: unknown }> = [];
  let planning = 0,
    maxPlanning = 0;
  const plans = { failure: false, mutate: false };
  class Runtime extends EventEmitter {
    children = new Map<string, ChildProcess>();
    startThread(options: { workingDirectory: string }) {
      return {
        run: async (prompt: string, { signal }: { signal: AbortSignal }) => {
          planning++;
          maxPlanning = Math.max(maxPlanning, planning);
          try {
            await new Promise((resolve) => setTimeout(resolve, 30));
            signal.throwIfAborted();
            await readFile(join(options.workingDirectory, "index.html"));
            return {
              finalResponse: JSON.stringify({
                cwd: ".",
                error: "",
                setup: plans.mutate
                  ? [
                      [
                        process.execPath,
                        "-e",
                        "require('fs').writeFileSync('index.html','changed')",
                      ],
                    ]
                  : [],
                command: plans.failure
                  ? [process.execPath, "-e", "process.exit(1)"]
                  : [
                      process.execPath,
                      "server.cjs",
                      prompt.match(/ポート(\d+)/)![1],
                    ],
              }),
            };
          } finally {
            planning--;
          }
        },
      };
    }
    request(
      method: string,
      input: {
        command: string[];
        cwd: string;
        processId: string;
        sandboxPolicy: unknown;
      },
    ) {
      if (method === "command/exec/terminate") {
        this.children.get(input.processId)?.kill();
        return Promise.resolve({});
      }
      if (method !== "command/exec") throw new Error(method);
      launches.push({ command: input.command, policy: input.sandboxPolicy });
      return new Promise((resolve, reject) => {
        const child = spawn(input.command[0], input.command.slice(1), {
          cwd: input.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        this.children.set(input.processId, child);
        child.on("error", reject);
        child.once("exit", (code) => {
          this.children.delete(input.processId);
          resolve({ exitCode: code });
        });
      });
    }
    async close() {
      await Promise.all(
        [...this.children.values()].map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null)
                return resolve();
              child.once("exit", () => resolve());
              child.kill("SIGKILL");
            }),
        ),
      );
    }
  }
  client.localPreviews.createCodex = () =>
    new Runtime() as unknown as AppServerCodex;
  client.localPreviews.checkAuthentication = async () => true;
  const post = (path: string, input: unknown, csrf = client.csrf) =>
    fetch(`${client.origin}/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(input),
    });
  return {
    client,
    artifacts,
    directory,
    launches,
    plans,
    maxPlanning: () => maxPlanning,
    post,
    close: async () => {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export async function until(
  check: () => boolean | Promise<boolean>,
  timeout = 10_000,
) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
