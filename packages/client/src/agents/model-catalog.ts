import { AppServerCodex } from "../codex/app-server.mjs";
import { codexBinary } from "../codex/binary.js";
import { workerEnvironment } from "@ido/common/runtime/platform";
import { selectedModel } from "./model-selection.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeBinary } from "../auth/claude.js";
import type { AgentCatalogEntry } from "@ido/common/contracts/api";

export async function authenticated(
  agent: "codex" | "claude",
  home: string,
  directory: string,
) {
  try {
    const { stdout } = await promisify(execFile)(
      agent === "claude" ? claudeBinary() : codexBinary(),
      agent === "claude" ? ["auth", "status", "--json"] : ["login", "status"],
      {
        cwd: directory,
        env: workerEnvironment(home),
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 32768,
      },
    );
    return agent === "codex" || JSON.parse(stdout).loggedIn === true;
  } catch {
    return false;
  }
}

export async function claudeModels(
  home: string,
  directory: string,
  create = query,
) {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Initialize the SDK control channel without submitting a user turn.
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await waiting;
  })();
  const controller = new AbortController();
  const runtime = create({
    prompt,
    options: {
      cwd: directory,
      env: workerEnvironment(home),
      abortController: controller,
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      plugins: [],
      tools: [],
      settings: { disableClaudeAiConnectors: true },
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runtime.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("MODEL_LIST_TIMEOUT")),
          15000,
        );
      }),
    ]);
    return result
      .map((value) => ({
        id: selectedModel(value.value)!,
        name: value.displayName.slice(0, 120),
      }))
      .filter((value) => value.id);
  } finally {
    clearTimeout(timer);
    controller.abort();
    release();
    runtime.close();
  }
}

export async function agentCatalog(
  home: string,
  directory: string,
  deps = {
    authenticated: (agent: "codex" | "claude") =>
      authenticated(agent, home, directory),
    models: (agent: "codex" | "claude") =>
      agent === "codex" ? codexModels(home) : claudeModels(home, directory),
  },
): Promise<AgentCatalogEntry[]> {
  return Promise.all(
    (["codex", "claude"] as const).map(async (agent) => {
      if (!(await deps.authenticated(agent)))
        return { agent, authenticated: false, models: [] };
      try {
        return { agent, authenticated: true, models: await deps.models(agent) };
      } catch {
        return {
          agent,
          authenticated: true,
          models: [],
          error: "MODEL_LIST_UNAVAILABLE",
        };
      }
    }),
  );
}

export async function codexModels(
  home: string,
  create = () =>
    new AppServerCodex({
      codexPathOverride: codexBinary(),
      env: workerEnvironment(home),
    }),
) {
  const runtime = create();
  try {
    const models = new Map<string, { id: string; name: string }>();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await runtime.request("model/list", {
        limit: 100,
        cursor,
      });
      for (const value of result.data ?? []) {
        if (value.hidden) continue;
        const id = selectedModel(value.model);
        if (id)
          models.set(id, {
            id,
            name: String(value.displayName ?? id).slice(0, 120),
          });
      }
      cursor = result.nextCursor;
      if (!cursor) return [...models.values()];
    }
    throw new Error("MODEL_LIST_TOO_LARGE");
  } finally {
    await runtime.close();
  }
}
