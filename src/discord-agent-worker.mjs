import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Codex } from "@openai/codex-sdk";
import WebSocket from "ws";
import {
  buildCodexEnvironment,
  buildPowerTaskPrompt,
} from "./discord-voice-openai.mjs";
import { TaskWorkspaceManager } from "./discord-voice-workspace.mjs";

const OPEN = 1;

function signChallenge(privateKey, challenge) {
  return sign(null, Buffer.from(String(challenge)), privateKey).toString(
    "base64url",
  );
}

function publicArtifacts(artifacts, runRevision) {
  return {
    hasChanges: artifacts?.hasChanges ?? false,
    status: artifacts?.status ?? "",
    runRevision,
    patchHash: artifacts?.patchHash,
    note: "差分は担当者端末の分離worktreeに保持されています。",
  };
}

async function readTaskState(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return {
      codexThreadId:
        typeof value.codexThreadId === "string"
          ? value.codexThreadId.slice(0, 200)
          : undefined,
      runRevision:
        Number.isSafeInteger(value.runRevision) && value.runRevision >= 0
          ? value.runRevision
          : 0,
    };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError)
      return { runRevision: 0 };
    throw error;
  }
}

async function writeTaskState(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export class LocalCodexWorkerExecutor {
  constructor({
    workingDirectory,
    workspaceDirectory,
    model,
    reasoningEffort = "medium",
    codex,
  }) {
    this.workingDirectory = resolve(workingDirectory);
    this.workspaceDirectory = resolve(workspaceDirectory);
    this.workspaces = new TaskWorkspaceManager({
      repository: this.workingDirectory,
      directory: this.workspaceDirectory,
    });
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.codex =
      codex ??
      new Codex({
        env: buildCodexEnvironment(process.env, process.env.CODEX_HOME),
        config: { analytics: { enabled: false } },
      });
  }

  async run(task, { signal, onProgress } = {}) {
    task.id ??= task.taskId;
    const previousWorkspace = join(this.workspaceDirectory, task.id);
    if (!task.workingDirectory && existsSync(previousWorkspace))
      task.workingDirectory = previousWorkspace;
    const workingDirectory = await this.workspaces.prepare(task);
    const statePath = join(
      this.workspaceDirectory,
      `${task.id}-agent-state.json`,
    );
    const localState = await readTaskState(statePath);
    const runRevision = localState.runRevision + 1;
    task.runRevision = runRevision;
    const options = {
      workingDirectory,
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      networkAccessEnabled: true,
      webSearchMode: "live",
      skipGitRepoCheck: false,
      additionalDirectories: [],
      model: this.model,
      modelReasoningEffort: this.reasoningEffort,
    };
    const thread = localState.codexThreadId
      ? this.codex.resumeThread(localState.codexThreadId, options)
      : this.codex.startThread(options);
    const prompt = task.additionalInstruction
      ? [
          "同じIssueへの追加指示です。元の依頼の権限範囲で作業を続けてください。",
          `追加指示:\n${task.additionalInstruction}`,
        ].join("\n")
      : buildPowerTaskPrompt({
          ...task,
          assignedAgentId: task.agentId,
          assignedAgentName: task.agentName,
        });
    const evidence = {
      runRevision,
      commands: 0,
      failedCommands: 0,
      unknownCommands: 0,
      tests: [],
      files: [],
    };
    if (typeof thread.runStreamed !== "function") {
      const result = await thread.run(prompt, { signal });
      const artifacts = await this.workspaces.collect(task);
      const codexThreadId = String(thread.id ?? "").slice(0, 200);
      await writeTaskState(statePath, { codexThreadId, runRevision });
      return {
        result: result.finalResponse,
        codexThreadId,
        runRevision,
        evidence,
        artifacts: publicArtifacts(artifacts, runRevision),
      };
    }
    const { events } = await thread.runStreamed(prompt, { signal });
    let finalResponse = "";
    let codexThreadId = localState.codexThreadId ?? thread.id;
    for await (const event of events) {
      if (event.type === "thread.started") codexThreadId = event.thread_id;
      if (event.type !== "item.completed") continue;
      if (event.item?.type === "agent_message") {
        finalResponse = String(event.item.text ?? "");
        await onProgress?.(finalResponse);
      }
      if (event.item?.type === "command_execution") {
        evidence.commands += 1;
        if (!Number.isInteger(event.item.exit_code))
          evidence.unknownCommands += 1;
        else if (event.item.exit_code !== 0) evidence.failedCommands += 1;
      }
      if (event.item?.type === "file_change")
        evidence.files = [
          ...new Set([
            ...evidence.files,
            ...(event.item.changes ?? []).map((change) => change.path),
          ]),
        ].slice(-100);
    }
    if (!finalResponse.trim())
      throw new Error("Codex returned an empty response.");
    const artifacts = await this.workspaces.collect(task);
    codexThreadId = String(codexThreadId ?? "").slice(0, 200);
    await writeTaskState(statePath, { codexThreadId, runRevision });
    return {
      result: finalResponse,
      codexThreadId,
      runRevision,
      evidence,
      artifacts: publicArtifacts(artifacts, runRevision),
    };
  }
}

export class DiscordAgentWorker {
  constructor({
    gatewayUrl,
    credential,
    pairingCode,
    name,
    capabilities = [],
    maximumConcurrentTasks = 1,
    executor,
    credentialWriter = async () => undefined,
    WebSocketClass = WebSocket,
    heartbeatIntervalMs = 15_000,
  }) {
    this.gatewayUrl = gatewayUrl ?? credential?.gatewayUrl;
    this.credential = credential;
    this.pairingCode = pairingCode;
    this.name = name;
    this.capabilities = capabilities;
    this.maximumConcurrentTasks = maximumConcurrentTasks;
    this.executor = executor;
    this.credentialWriter = credentialWriter;
    this.WebSocketClass = WebSocketClass;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.tasks = new Map();
  }

  connect() {
    if (!/^wss?:\/\//.test(this.gatewayUrl ?? ""))
      throw new Error("A Worker gateway URL is required.");
    const url = new URL(this.gatewayUrl);
    if (
      url.protocol !== "wss:" &&
      !["127.0.0.1", "::1", "localhost"].includes(url.hostname)
    )
      throw new Error("Worker connections must use wss:// away from loopback.");
    this.stopping = false;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.#open();
    return this.ready;
  }

  #open() {
    this.socket = new this.WebSocketClass(this.gatewayUrl, {
      maxPayload: 256 * 1024,
    });
    this.socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(Buffer.from(data).toString("utf8"));
      } catch {
        this.rejectReady?.(new Error("Worker gateway sent invalid JSON."));
        this.socket?.close(4002, "Invalid gateway message");
        return;
      }
      void this.#message(message).catch((error) => {
        this.rejectReady?.(error);
        this.socket?.close(4002, "Gateway message failed");
      });
    });
    this.socket.once("error", (error) => this.rejectReady?.(error));
    this.socket.once("close", () => {
      clearInterval(this.heartbeat);
      for (const controller of this.tasks.values()) controller.abort();
      this.tasks.clear();
      if (!this.stopping && this.credential) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.#open(), 2_000);
        this.reconnectTimer.unref?.();
      }
    });
  }
  async stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    for (const controller of this.tasks.values()) controller.abort();
    this.tasks.clear();
    if (!this.socket || this.socket.readyState > OPEN) return;
    await new Promise((resolve) => {
      this.socket.once("close", resolve);
      this.socket.close(1000, "Worker stopped");
    });
  }

  #send(value) {
    if (this.socket?.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(value));
    return true;
  }

  async #message(message) {
    if (message.type === "error") {
      const error = new Error(
        message.message ?? "Worker gateway rejected the request.",
      );
      error.code = message.code;
      this.socket?.close(4002, "Gateway rejected the request");
      throw error;
    }
    if (message.type === "challenge") {
      if (this.pairingCode) {
        const keys = generateKeyPairSync("ed25519");
        this.pendingPrivateKey = keys.privateKey.export({
          type: "pkcs8",
          format: "pem",
        });
        this.pendingPublicKey = keys.publicKey.export({
          type: "spki",
          format: "pem",
        });
        this.#send({
          type: "pair",
          code: this.pairingCode,
          publicKey: this.pendingPublicKey,
          signature: signChallenge(this.pendingPrivateKey, message.challenge),
          name: this.name,
          capabilities: this.capabilities,
          maximumConcurrentTasks: this.maximumConcurrentTasks,
        });
        return;
      }
      if (!this.credential) throw new Error("This Worker has not been paired.");
      this.#send({
        type: "authenticate",
        agentId: this.credential.agentId,
        token: this.credential.token,
        signature: signChallenge(this.credential.privateKey, message.challenge),
      });
      return;
    }
    if (message.type === "paired") {
      this.credential = {
        agentId: message.agentId,
        token: message.token,
        publicKey: this.pendingPublicKey,
        privateKey: this.pendingPrivateKey,
        gatewayUrl: this.gatewayUrl,
        storedAt: new Date().toISOString(),
      };
      await this.credentialWriter(this.credential);
      this.pairingCode = undefined;
      this.#online();
      return;
    }
    if (message.type === "authenticated") {
      this.#online();
      return;
    }
    if (message.type === "cancel") {
      this.tasks.get(message.leaseId)?.abort();
      return;
    }
    if (message.type === "task") void this.#task(message);
  }

  #online() {
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(
      () => this.#send({ type: "heartbeat", at: Date.now() }),
      this.heartbeatIntervalMs,
    );
    this.heartbeat.unref?.();
    this.resolveReady?.(this.credential);
    this.resolveReady = undefined;
    this.rejectReady = undefined;
  }

  async #task(task) {
    if (this.tasks.size >= this.maximumConcurrentTasks) {
      this.#send({
        type: "task_error",
        leaseId: task.leaseId,
        message: "Worker concurrency is full.",
      });
      return;
    }
    const controller = new AbortController();
    this.tasks.set(task.leaseId, controller);
    try {
      const result = await this.executor.run(
        {
          ...task,
          agentId: this.credential.agentId,
          agentName: this.name,
        },
        {
          signal: controller.signal,
          onProgress: (content) =>
            this.#send({ type: "progress", leaseId: task.leaseId, content }),
        },
      );
      this.#send({ type: "result", leaseId: task.leaseId, ...result });
    } catch (error) {
      this.#send({
        type: "task_error",
        leaseId: task.leaseId,
        message: controller.signal.aborted
          ? "Task was cancelled."
          : `Codex Worker failed (${error?.name ?? "Error"}).`,
      });
    } finally {
      this.tasks.delete(task.leaseId);
    }
  }
}
