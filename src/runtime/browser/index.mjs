import { readFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { createConversationEngine } from "../../engine/conversation.mjs";
import { createCodexBackend } from "../../execution/codex/backend.mjs";
import { bindExecution } from "../../execution/port.mjs";
import { bindCoordinator } from "../../execution/coordinator-port.mjs";
import { MeetingStateStore } from "../../storage/meeting-state.mjs";
import {
  TaskPreviewManager,
  parsePreviewCommand,
} from "../../execution/preview.mjs";
import {
  browserPreviewVerifier,
  parsePreviewChecks,
} from "../../execution/preview-browser.mjs";
import { createStudioController } from "../../adapters/browser/controller.mjs";
import { createStudioArtifactReader } from "../studio-artifacts.mjs";
import { createHudStore } from "../hud-server.mjs";
import { startStudioServer } from "../studio-server.mjs";
import { createPreviewRelay } from "../preview-relay.mjs";
import { readStudioAccess } from "../studio-access.mjs";

export async function loadBrowserConfig(path) {
  if (!path)
    throw new Error(
      "Set IDD_STUDIO_CONFIG to the local project configuration JSON",
    );
  const config = JSON.parse(await readFile(path, "utf8"));
  if (
    !Array.isArray(config.projects) ||
    !config.projects.length ||
    config.projects.length > 8
  )
    throw new Error("Configure 1 to 8 projects");
  const ids = new Set();
  for (const project of config.projects) {
    if (!/^[a-zA-Z0-9_-]{1,50}$/.test(project.id ?? "") || ids.has(project.id))
      throw new Error("Project IDs must be unique URL-safe names");
    ids.add(project.id);
    if (!isAbsolute(project.directory ?? ""))
      throw new Error("Project directories must be absolute paths");
    project.previewCommand = parsePreviewCommand(
      project.previewCommand
        ? JSON.stringify(project.previewCommand)
        : undefined,
    );
    project.previewChecks = parsePreviewChecks(
      project.previewChecks ? JSON.stringify(project.previewChecks) : undefined,
    );
  }
  config.stateDirectory = resolve(
    config.stateDirectory ?? join(homedir(), ".local/state/idd-studio"),
  );
  return config;
}

export async function startBrowserStudio({
  config,
  dependencies = {},
  logger = console,
} = {}) {
  const rooms = new Map();
  const resources = [];
  const host = config.host ?? "127.0.0.1";
  const relay = createPreviewRelay({
    host,
    publicHost: config.publicOrigin
      ? new URL(config.publicOrigin).hostname
      : "127.0.0.1",
  });
  let server;
  let stopped;
  const stop = () =>
    (stopped ??= (async () => {
      await server?.close();
      const settlements = await Promise.allSettled(
        resources.map(
          async ({ controller, engine, previews, execution, store }) => {
            const outcomes = await Promise.allSettled([
              controller?.close(),
              engine?.session.stop(),
              engine?.taskQueue?.stop(),
              previews?.close(),
            ]);
            outcomes.push(
              ...(await Promise.allSettled([
                execution?.close(),
                store.release(),
              ])),
            );
            const failures = outcomes
              .filter((item) => item.status === "rejected")
              .map((item) => item.reason);
            if (failures.length)
              throw new AggregateError(failures, "Studio cleanup incomplete");
          },
        ),
      );
      await relay.close();
      const failures = settlements
        .filter((item) => item.status === "rejected")
        .map((item) => item.reason);
      if (failures.length)
        throw new AggregateError(
          failures,
          "Studio stopped with incomplete cleanup or persistence",
        );
    })());
  try {
    for (const project of config.projects) {
      const root = join(config.stateDirectory, project.id);
      const engineConfig = {
        workingDirectory: project.directory,
        statePath: join(root, "codex.json"),
        meetingStatePath: join(root, "meeting.json"),
        taskWorkspaceDirectory: join(root, "workspaces"),
        isolatedCodexHome: join(root, "codex-home"),
        codexHome: config.codexHome,
        codexExecutable: config.codexExecutable ?? "codex",
        codexTransport: "app-server",
        powerMode: true,
        voiceMode: "meeting",
        allowedUserId: "browser-operator",
        allParticipantsOperate: true,
        autonomousTasks: false,
        requireWakeWord: true,
        answerUnaddressedQuestions: false,
        immediateReactions: true,
        taskConcurrency: 2,
        maximumPendingTasks: 10,
        observationIntervalMs: 30000,
        codexModel: "gpt-5.6-sol",
        codexReasoningEffort: "low",
        observerModel: "gpt-5.6-sol",
        observerReasoningEffort: "low",
        taskModel: "gpt-5.6-sol",
        taskReasoningEffort: "low",
        complexTaskModel: "gpt-5.6-sol",
        complexTaskReasoningEffort: "low",
        codexTimeoutMs: 900000,
      };
      const store = new MeetingStateStore(
        engineConfig.meetingStatePath,
        `browser:${project.id}:${project.directory}`,
      );
      const resource = { store };
      resources.push(resource);
      await store.acquire();
      const saved = await store.load();
      const hudStore = createHudStore();
      const backend =
        dependencies.executionBackend?.(project, engineConfig) ??
        createCodexBackend(engineConfig);
      const execution = (resource.execution = bindExecution(backend));
      const coordinator =
        dependencies.coordinator?.(project, engineConfig) ??
        (backend.createCoordinator ? bindCoordinator(backend) : undefined);
      await execution.prepare();
      const previews = (resource.previews = new TaskPreviewManager({
        command: project.previewCommand,
        workspaceRoot: engineConfig.taskWorkspaceDirectory,
        codexExecutable: engineConfig.codexExecutable,
        codexHome: engineConfig.isolatedCodexHome,
        verify:
          dependencies.verifyPreview ??
          browserPreviewVerifier(project.previewChecks, {
            executablePath: config.browserExecutable,
          }),
        onChange: async (task) => {
          await relay.expose(task);
          await task.checkpoint?.();
        },
      }));
      const engine = (resource.engine = await createConversationEngine({
        config: engineConfig,
        coordinator,
        workPort: dependencies.workPort?.(project, engineConfig),
        store,
        initialState: saved,
        logger,
        onEvent: (event) => hudStore.publish(event),
        execution: {
          ...execution,
          runTask: async (task, options) => {
            await previews.stop(task.id, "superseded");
            const result = await execution.runTask(task, options);
            try {
              await previews.start(task, options);
            } catch {
              task.preview = {
                state: "failed",
                runRevision: task.runRevision,
                specRevision: task.specRevision,
              };
            }
            return result;
          },
          confirmPreview: (task, revision, userId) =>
            previews.confirm(task, revision, userId),
          restartPreview: (task) => previews.start(task),
          invalidatePreview: (task, state = "superseded") =>
            previews.stop(task.id, state),
        },
        output: { postText: async () => {} },
      }));
      const controller = (resource.controller = createStudioController({
        engine,
        store,
        initialState: saved,
        hudStore,
        name: project.name ?? project.id,
        previewConfigured: Boolean(project.previewCommand),
        readArtifacts: createStudioArtifactReader({
          workspaceRoot: engineConfig.taskWorkspaceDirectory,
        }),
      }));
      rooms.set(project.id, {
        name: project.name ?? project.id,
        description: project.description,
        controller,
        engine,
      });
    }
    const accessPath = join(config.stateDirectory, "access.json");
    const access = await readStudioAccess(accessPath);
    server = await startStudioServer({
      rooms,
      port: config.port ?? 4311,
      host,
      publicOrigin: config.publicOrigin,
      ...access,
    });
    return { server, rooms, stop, accessPath };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}
