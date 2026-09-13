import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AgentBrowserLogin } from "./discord-agent-login.mjs";
import { AgentTaskMonitor } from "./discord-agent-task-monitor.mjs";
import { AgentCommandApproval } from "./discord-agent-command-approval.mjs";
import { AgentPausableExecution } from "./discord-agent-pause.mjs";
import { AgentSandboxSetup } from "./discord-agent-sandbox.mjs";
import { validateAgentEndpoint } from "./discord-agent-endpoint.mjs";
import { AgentExecutionConsent } from "./discord-agent-execution-consent.mjs";
import { decodeAgentInvitation } from "./discord-agent-onboarding.mjs";
import {
  DiscordAgentWorker,
  LocalCodexWorkerExecutor,
} from "./discord-agent-worker.mjs";
import {
  readAgentWorkerCredential,
  writeAgentWorkerCredential,
} from "./discord-agent-worker-credentials.mjs";

const exec = promisify(execFile);
class UiError extends Error {}
const defaultDirectory = join(
  process.env.LOCALAPPDATA ?? join(homedir(), ".local", "state"),
  "personal-context-hub",
  "agent-ui",
);

export async function createAgentUi({
  directory = defaultDirectory,
  port = 0,
  login,
  createWorker = (options) => new DiscordAgentWorker(options),
  createExecutor = (options) => new LocalCodexWorkerExecutor(options),
  readCredential = readAgentWorkerCredential,
  writeCredential = writeAgentWorkerCredential,
  validateRepository = async (path) => {
    await exec("git", ["-C", path, "rev-parse", "--show-toplevel"], {
      windowsHide: true,
      timeout: 10_000,
    });
  },
  connectionTimeoutMs = 30_000,
  approvalTimeoutMs = 90_000,
  pickFolder,
  taskMonitor = new AgentTaskMonitor(),
  assetDirectory = new URL("./", import.meta.url),
  commandApproval = new AgentCommandApproval(),
  interactiveApprovals = false,
} = {}) {
  // Keep the connection agent's Codex configuration separate from personal
  // plugins, hooks and MCP settings. The official login stores its own auth.
  const codexHome = join(directory, "codex-home");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const sandboxSetup = new AgentSandboxSetup(codexHome);
  login ??= new AgentBrowserLogin({
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  const token = randomBytes(32).toString("base64url");
  let profile = {};
  try {
    profile = JSON.parse(
      await readFile(join(directory, "profile.json"), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let worker;
  let consent;
  let connectionPolicy;
  let busy = false;
  let lastError = "";
  let origin;
  let closing = false;
  let pausable;
  const page = await readFile(
    new URL("./discord-agent-ui.html", assetDirectory),
    "utf8",
  );
  const script = await readFile(
    new URL("./discord-agent-ui-client.js", assetDirectory),
    "utf8",
  );
  const joinPage = await readFile(
    new URL("./discord-agent-join.html", import.meta.url),
    "utf8",
  );
  const joinScript = await readFile(
    new URL("./discord-agent-join-client.js", import.meta.url),
    "utf8",
  );

  const stop = async () => {
    const previous = worker;
    worker = undefined;
    await previous?.stop();
    await taskMonitor.close();
    consent = undefined;
    connectionPolicy = undefined;
  };
  const connect = async (input) => {
    if (closing) throw new UiError("アプリを終了しています。");
    if (sandboxSetup.state.pending)
      throw new UiError("サンドボックスの設定完了を待ってください。");
    if (busy || worker) throw new UiError("先に接続を停止してください。");
    busy = true;
    lastError = "";
    let timer;
    try {
      if (!(await login.refresh()).authenticated)
        throw new UiError("先にOpenAIへログインしてください。");
      if (closing) throw new UiError("アプリを終了しています。");
      if (
        typeof input.workingDirectory !== "string" ||
        !input.workingDirectory.trim()
      )
        throw new UiError("作業フォルダーを指定してください。");
      const workingDirectory = resolve(input.workingDirectory.trim());
      try {
        await validateRepository(workingDirectory);
      } catch {
        throw new UiError("作業フォルダーにGitリポジトリが見つかりません。");
      }
      const pairingCode = String(input.pairingCode ?? "").trim();
      let credential;
      if (!pairingCode) {
        try {
          credential = await readCredential();
        } catch {
          throw new UiError("Discordで新しい参加コードを取得してください。");
        }
      }
      const gatewayUrl = String(
        input.gatewayUrl ?? credential?.gatewayUrl ?? "",
      ).trim();
      try {
        validateAgentEndpoint(gatewayUrl);
      } catch {
        throw new UiError(
          "接続先URLを確認してください。公開接続先はwss://を使い、認証情報・クエリ・#を含めないでください。",
        );
      }
      if (credential && gatewayUrl !== credential.gatewayUrl)
        throw new UiError("接続先の変更には新しい参加コードが必要です。");
      const nextProfile = {
        workingDirectory,
        gatewayUrl,
        name: String(input.name ?? "")
          .trim()
          .slice(0, 80),
      };
      // Persist only local preferences, never the pairing code or credentials.
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, "profile.json.tmp"),
        JSON.stringify(nextProfile),
        { mode: 0o600 },
      );
      await rename(
        join(directory, "profile.json.tmp"),
        join(directory, "profile.json"),
      );
      profile = nextProfile;
      connectionPolicy = {
        automatic: input.automatic === true,
        networkAccess: input.networkAccess === true,
      };
      const executorOptions = {
        workingDirectory,
        codexHome,
        networkAccess: input.networkAccess === true,
        requestApproval: interactiveApprovals
          ? (taskId, method, params, signal) =>
              commandApproval.request(taskId, method, params, signal)
          : undefined,
        workspaceDirectory: join(
          directory,
          "workspaces",
          createHash("sha256")
            .update(workingDirectory)
            .digest("hex")
            .slice(0, 16),
        ),
      };
      pausable = new AgentPausableExecution({
        execute: async (task, options, networkAccess) => {
          try {
            return await createExecutor({
              ...executorOptions,
              networkAccess,
            }).run(task, options);
          } finally {
            commandApproval.cancelTask(task.id);
          }
        },
        onState: (id, state) => {
          const record = taskMonitor.records.get(id);
          if (record) record.state = state;
        },
      });
      consent = new AgentExecutionConsent({
        automatic: input.automatic === true,
        timeoutMs: approvalTimeoutMs,
        executor: {
          run: (task, options) => {
            taskMonitor.markRunning(task.id);
            return pausable.run(task, options, input.networkAccess === true);
          },
        },
      });
      if (closing) throw new UiError("アプリを終了しています。");
      worker = createWorker({
        gatewayUrl,
        credential,
        pairingCode: pairingCode || undefined,
        name: nextProfile.name || undefined,
        capabilities: ["*"],
        maximumConcurrentTasks: 1,
        executor: taskMonitor.wrap(consent, {
          automatic: input.automatic === true,
          workingDirectory,
        }),
        credentialWriter: writeCredential,
      });
      await Promise.race([
        worker.connect(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new UiError(
                  "接続がタイムアウトしました。Botの稼働と接続先・参加コードを確認してください。",
                ),
              ),
            connectionTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      await stop();
      // Remote errors and subprocess output can include untrusted/private data.
      const safe = error instanceof UiError;
      lastError = safe
        ? error.message.slice(0, 200)
        : "接続できませんでした。接続先と参加コードを確認してください。";
      throw new UiError(lastError);
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  };

  const server = createServer(async (request, response) => {
    const send = (status, data, type = "application/json") => {
      response.writeHead(status, {
        "Content-Type": `${type}; charset=utf-8`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      response.end(type === "application/json" ? JSON.stringify(data) : data);
    };
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin)
    )
      return send(403, { error: "Forbidden" });
    // Even read endpoints require the per-launch capability. The bootstrap URL
    // keeps it in a fragment so it is not sent in HTTP requests or referrers.
    if (request.method === "GET" && request.url === "/")
      return send(200, page, "text/html");
    if (request.method === "GET" && request.url === "/client.js")
      return send(200, script, "text/javascript");
    // The public landing page can only forward an invitation to an already
    // authorized tab. It never receives the UI capability or any local status.
    if (request.method === "GET" && request.url === "/join")
      return send(200, joinPage, "text/html");
    if (request.method === "GET" && request.url === "/join.js")
      return send(200, joinScript, "text/javascript");
    if (request.headers.authorization !== `Bearer ${token}`)
      return send(403, { error: "Forbidden" });
    try {
      if (request.method === "GET" && request.url === "/status")
        return send(200, {
          login: login.state,
          profile,
          busy,
          lastError,
          connected: Boolean(
            worker?.socket?.readyState === 1 && worker?.authenticated,
          ),
          reconnecting: Boolean(
            worker && !worker.authenticated && !worker.reconnectDisabled,
          ),
          revoked: Boolean(worker?.reconnectDisabled),
          canPickFolder: Boolean(pickFolder) || process.platform === "win32",
          tasks: taskMonitor.list(),
          commandApprovals: commandApproval.list(),
          sandboxSetup: sandboxSetup.state,
          approvals: consent?.describe() ?? [],
          connectionPolicy,
        });
      if (
        request.method !== "POST" ||
        request.headers.origin !== origin ||
        request.headers["content-type"] !== "application/json"
      )
        return send(403, { error: "Forbidden" });
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16_384) return send(413, { error: "Request too large" });
        chunks.push(chunk);
      }
      const contents = Buffer.concat(chunks).toString("utf8");
      const input = JSON.parse(contents || "{}");
      if (request.url === "/setup-sandbox") {
        if (!sandboxSetup.state.supported || sandboxSetup.state.pending)
          return send(409, { error: "セットアップを開始できません。" });
        if (worker || busy || closing)
          return send(409, {
            error: "接続を停止してからセットアップしてください。",
          });
        const cwd =
          typeof input.workingDirectory === "string" &&
          input.workingDirectory.trim()
            ? resolve(input.workingDirectory.trim())
            : undefined;
        if (!cwd)
          return send(400, { error: "作業フォルダーを選んでください。" });
        busy = true;
        try {
          await validateRepository(cwd);
          if (closing) return send(409, { error: "アプリを終了しています。" });
          sandboxSetup.start(cwd);
        } finally {
          busy = false;
        }
        return send(200, { ok: true });
      }
      if (request.url === "/pause-task") {
        if (!(await pausable?.pause(input.id)))
          return send(409, { error: "このタスクは一時停止できません。" });
        return send(200, { ok: true });
      }
      if (request.url === "/resume-task") {
        if (!pausable?.resume(input.id, input.networkAccess))
          return send(409, { error: "停止完了を待ってから再開してください。" });
        return send(200, { ok: true });
      }
      if (request.url === "/approve-command") {
        if (!commandApproval.decide(input.id, input.approved))
          return send(409, { error: "この操作の承認依頼は終了しています。" });
        return send(200, { ok: true });
      }
      if (request.url === "/stop-task") {
        if (!taskMonitor.cancel(input.id))
          return send(409, { error: "このタスクは実行中ではありません。" });
        return send(200, { ok: true });
      }
      if (request.url === "/folder" && pickFolder)
        return send(200, { path: await pickFolder() });
      if (request.url === "/invitation") {
        if (worker || busy)
          return send(409, { error: "先に接続を停止してください。" });
        try {
          return send(200, decodeAgentInvitation(input.invitation));
        } catch {
          return send(400, {
            error:
              "参加情報が無効または期限切れです。Discordで再発行してください。",
          });
        }
      }
      if (request.url === "/approve") {
        if (
          typeof input.approved !== "boolean" ||
          !consent?.decide(input.id, input.approved)
        )
          return send(409, { error: "この確認依頼は終了しています。" });
        return send(200, { ok: true });
      }
      if (request.url === "/login") {
        if (busy || worker)
          return send(409, {
            error: "ログインし直す前に接続を停止してください。",
          });
        login.start();
        return send(200, { ok: true });
      }
      if (request.url === "/refresh-login")
        return send(200, await login.refresh());
      if (request.url === "/connect") {
        await connect(input);
        return send(200, { ok: true });
      }
      if (request.url === "/stop") {
        if (busy)
          return send(409, {
            error: "接続処理が完了してから停止してください。",
          });
        await stop();
        return send(200, { ok: true });
      }
      if (request.url === "/folder" && process.platform === "win32") {
        const { stdout } = await exec(
          "powershell.exe",
          [
            "-NoProfile",
            "-STA",
            "-EncodedCommand",
            Buffer.from(
              "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; if ($dialog.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Write($dialog.SelectedPath) }",
              "utf16le",
            ).toString("base64"),
          ],
          { windowsHide: true, timeout: 120_000 },
        );
        return send(200, { path: stdout.trim() });
      }
      return send(404, { error: "Not found" });
    } catch {
      return send(400, {
        error:
          lastError ||
          "操作に失敗しました。入力内容を確認してもう一度お試しください。",
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  void login.refresh();
  return {
    url: `${origin}/#${token}`,
    async close() {
      closing = true;
      commandApproval.close();
      login.stop();
      await sandboxSetup.close();
      await stop();
      await taskMonitor.close();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      });
    },
  };
}
