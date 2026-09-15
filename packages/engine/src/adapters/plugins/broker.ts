import type {
  ConversationInput,
  InputContext,
} from "@ido/common/contracts/plugins";
import { text, type Task } from "@ido/common/contracts/protocol";
import {
  Projects,
  DEFAULT_PROJECT,
} from "../../processing/projects/service.js";
import { Contexts } from "../../management/contexts.js";
import { Identities } from "../../management/identities.js";
import type { Workspace } from "../../output/queries/workspace.js";
import type { Repository } from "../../ports/repository.js";
import type { InputRouter } from "../../processing/routing/input.js";
import type { Plugins } from "./host.js";
import {
  forumProjects,
  boundForumTask,
} from "../../processing/tasks/forum-binding.js";
import {
  TaskBoard,
  projectDiscussion,
  type BoardThread,
} from "../../processing/tasks/board.js";
export class PluginBroker {
  readonly contexts: Contexts;
  readonly identities: Identities;
  constructor(
    readonly store: Repository,
    readonly plugins: () => Plugins,
    readonly router: InputRouter,
    readonly workspace: Workspace,
    readonly origin: () => string,
  ) {
    this.contexts = new Contexts(store);
    this.identities = new Identities(store);
  }
  context(pluginId: string, token: string): InputContext {
    const plugin = this.plugins().get(pluginId);
    const generation = plugin.generation,
      revision = plugin.revision;
    const { user } = this.contexts.resolve(pluginId, generation, token);
    return {
      pluginId,
      actor: user,
      valid: () => {
        try {
          this.contexts.resolve(pluginId, plugin.generation, token);
          return (
            plugin.generation === generation &&
            plugin.revision === revision &&
            this.store.user(user.id)?.role === user.role
          );
        } catch {
          return false;
        }
      },
      deliver: async (output) => {
        if (plugin.generation === generation && plugin.revision === revision)
          await plugin.request("output", { output });
      },
      publish: (event) => {
        if (plugin.generation === generation && plugin.revision === revision)
          this.plugins().publish(event);
      },
    };
  }
  async request(
    pluginId: string,
    operation: string,
    input: Record<string, unknown>,
    token?: string,
  ): Promise<unknown> {
    const plugin = this.plugins().get(pluginId);
    if (operation === "connection.info") return { origin: this.origin() };
    if (operation === "tasks.snapshot") {
      const config = this.store.get<Record<string, string>>("config", pluginId);
      if (
        !plugin.manifest?.capabilities.includes("task-forum") ||
        !config?.issueForumChannelId ||
        !config.projectId
      )
        throw new Error("PERMISSION_DENIED");
      const projects = forumProjects(this.store, pluginId, config, true);
      return this.store
        .list<Task>("task")
        .filter((task) => projects.includes(task.projectId))
        .concat(projects.map(projectDiscussion))
        .map((task) => ({
          ...task,
          discussion: task.id === projectDiscussion(task.projectId).id,
          boardPosts: (
            this.store.get<BoardThread>("task-board", task.id)?.posts ?? []
          )
            .filter(
              (post) =>
                post.id >
                (Number(
                  (input.boardAfter as Record<string, unknown> | undefined)?.[
                    task.id
                  ],
                ) || 0),
            )
            .slice(0, 20)
            .map((post) => {
              const author = this.store.get<Task>("task", post.authorTaskId);
              const device = author?.clientId
                ? this.store.get<import("../../domain/models.js").Device>(
                    "device",
                    author.clientId,
                  )
                : undefined;
              return {
                id: post.id,
                body: post.body,
                author:
                  post.authorName ??
                  `${device?.profile?.name ?? device?.name ?? "Agent"} · ${author?.agent ?? "codex"}`,
                external: post.external,
              };
            }),
        }));
    }
    if (operation === "projects.current") {
      if (!plugin.manifest?.capabilities.includes("project-conversation"))
        throw new Error("PERMISSION_DENIED");
      const config =
        this.store.get<Record<string, string>>("config", pluginId) ?? {};
      const projects = new Projects(this.store);
      const projectId = projects.project(config.projectId || DEFAULT_PROJECT);
      const conversation = projects.current(projectId);
      return {
        project: this.store.get("project", projectId),
        meeting: this.store.get("meeting", conversation.meetingId),
      };
    }
    if (operation === "projects.list" || operation === "projects.select") {
      if (!plugin.manifest?.capabilities.includes("project-conversation"))
        throw new Error("PERMISSION_DENIED");
      const actor = this.identities.resolve(pluginId, text(input.subject, 100));
      if (!actor || actor.role === "viewer")
        throw new Error("PERMISSION_DENIED");
      const config =
        this.store.get<Record<string, string>>("config", pluginId) ?? {};
      if (operation === "projects.list")
        return {
          projects: this.store.list("project"),
          projectId: config.projectId || DEFAULT_PROJECT,
        };
      const selected = new Projects(this.store).selectByNameOrId(
        input.projectId,
      );
      const projectId = selected.id;
      if (projectId === (config.projectId || DEFAULT_PROJECT)) return selected;
      forumProjects(this.store, pluginId, config, true);
      forumProjects(this.store, pluginId, { ...config, projectId }, true);
      this.store.put("config", pluginId, {
        ...config,
        projectId,
        projectRevision: String(Number(config.projectRevision ?? 0) + 1),
      });
      return this.store.get("project", projectId);
    }
    if (operation.startsWith("storage.")) {
      const key = text(input.key, 500);
      if (operation === "storage.get")
        return this.store.get(`plugin:${pluginId}`, key);
      if (operation === "storage.put") {
        this.store.put(`plugin:${pluginId}`, key, input.value);
        return { ok: true };
      }
      throw new Error("UNKNOWN_OPERATION");
    }
    if (operation === "identity.session") {
      if (!plugin.manifest?.capabilities.includes("activity"))
        throw new Error("PERMISSION_DENIED");
      const user = this.identities.linked(pluginId, text(input.subject, 100));
      if (!user) throw new Error("LINK_ACCOUNT_FIRST");
      return {
        token: this.contexts.issue(
          pluginId,
          user.id,
          plugin.generation,
          "activity",
        ),
      };
    }
    if (operation === "identity.me") {
      const { user, scope } = this.contexts.resolve(
        pluginId,
        plugin.generation,
        token,
      );
      if (scope !== "member") throw new Error("PERMISSION_DENIED");
      return { ...user, origin: this.origin() };
    }
    if (operation === "identity.link") {
      const { user, scope } = this.contexts.resolve(
        pluginId,
        plugin.generation,
        token,
      );
      if (scope !== "member") throw new Error("PERMISSION_DENIED");
      this.identities.link(pluginId, text(input.subject, 100), user.id);
      return { ok: true };
    }
    if (operation === "input") {
      let event = input as unknown as ConversationInput;
      validateMediaInput(event);
      if (
        (event.audioFrame || event.activity) &&
        !plugin.manifest?.capabilities.includes("audio-stream")
      )
        throw new Error("PERMISSION_DENIED");
      text(event.eventId, 200);
      if (event.meetingId) text(event.meetingId, 100);
      if (
        event.audio &&
        (typeof event.audio !== "string" ||
          event.audio.length > 9 * 1024 * 1024)
      )
        throw new Error("INPUT_TOO_LARGE");
      if (event.text) text(event.text);
      if (
        event.command &&
        !["ask", "task", "stop", "steer", "context", "mode"].includes(
          event.command,
        )
      )
        throw new Error("INVALID_COMMAND");
      let context: InputContext;
      if (token) context = this.context(pluginId, token);
      else {
        const config = this.store.get<Record<string, string>>(
          "config",
          pluginId,
        );
        const projectRouting = plugin.manifest?.capabilities.includes(
          "project-conversation",
        );
        const pinned = event.capture
          ? this.store.get<{ projectId: string }>(
              "utterance-route",
              `${pluginId}:${event.capture.sessionId}:${event.capture.utteranceId}`,
            )
          : undefined;
        const forumTask =
          config && ["steer", "stop", "context"].includes(event.command ?? "")
            ? boundForumTask(
                this.store,
                pluginId,
                config,
                event.taskId,
                (event.replyTo as { channelId?: string } | undefined)
                  ?.channelId,
              )
            : undefined;
        if (
          !config ||
          (projectRouting
            ? event.projectId &&
              event.projectId !==
                (forumTask?.projectId ??
                  pinned?.projectId ??
                  config.projectId ??
                  DEFAULT_PROJECT)
            : config.meetingId !== event.meetingId ||
              config.projectId !== event.projectId)
        )
          throw new Error("INPUT_BINDING_MISMATCH");
        if (projectRouting)
          event = {
            ...event,
            meetingId: "",
            projectId:
              forumTask?.projectId ??
              pinned?.projectId ??
              config.projectId ??
              DEFAULT_PROJECT,
          };
        const selectedRevision = config.projectRevision;
        if (
          !plugin.manifest?.capabilities.includes(
            event.audioFrame || event.activity
              ? "audio-stream"
              : event.audio
                ? "audio"
                : "text",
          )
        )
          throw new Error("PERMISSION_DENIED");
        const actor = this.identities.resolve(
          pluginId,
          text(event.subject, 100),
        );
        if (!actor) throw new Error("PERMISSION_DENIED");
        if (
          forumTask &&
          actor.role !== "viewer" &&
          ["steer", "context"].includes(event.command ?? "") &&
          event.text?.trim()
        ) {
          new TaskBoard(this.store).post(
            forumTask,
            { body: event.text },
            `discord:${event.eventId}`,
            actor.name,
          );
          if (event.command === "context") return { ok: true };
          if (forumTask.id === projectDiscussion(forumTask.projectId).id)
            throw new Error("DISCUSSION_IS_NOT_A_TASK");
          if (/^再開[:：]/.test(event.text)) {
            const receipt = this.workspace.tasks.control(
              forumTask.id,
              actor.id,
              "retry",
              undefined,
              {
                requestKey: `discord:${event.eventId}`,
                expectedRevision: forumTask.revision,
                continuation: event.text.replace(/^再開[:：]\s*/, ""),
              },
            );
            this.workspace.flush();
            return receipt;
          }
          event.text = event.text.replace(/^(?:指示|追加指示)[:：]\s*/, "");
        }
        const generation = plugin.generation,
          revision = plugin.revision;
        context = {
          pluginId,
          actor,
          valid: () =>
            plugin.generation === generation &&
            plugin.revision === revision &&
            this.store.conversationAuthor(actor.id)?.role === actor.role &&
            this.identities.resolve(pluginId, event.subject!)?.id === actor.id,
          deliver: async (output) => {
            if (
              context.valid() &&
              (forumTask ||
                (this.store.get<Record<string, string>>("config", pluginId)
                  ?.projectRevision === selectedRevision &&
                  (!projectRouting ||
                    event.projectId ===
                      (this.store.get<Record<string, string>>(
                        "config",
                        pluginId,
                      )?.projectId ?? DEFAULT_PROJECT))))
            )
              await plugin.request("output", { output });
          },
          publish: (event) => {
            if (context.valid()) this.plugins().publish(event);
          },
        };
      }
      if (!context.valid() || context.actor.role === "viewer")
        throw new Error("PERMISSION_DENIED");
      event = new Projects(this.store).accept(
        { ...event, meetingId: event.meetingId || undefined },
        pluginId,
      );
      return this.router.handle(event, context);
    }
    const context = this.context(pluginId, token ?? "");
    const { scope } = this.contexts.resolve(pluginId, plugin.generation, token);
    return this.workspace.request(
      operation,
      input,
      context,
      scope === "activity",
    );
  }
}

export function validateMediaInput(event: ConversationInput) {
  if (
    event.priority !== undefined &&
    !["normal", "immediate"].includes(event.priority)
  )
    throw new Error("INVALID_INPUT_PRIORITY");
  if (
    event.conversationMode !== undefined &&
    !["text-speech", "live"].includes(event.conversationMode)
  )
    throw new Error("INVALID_CONVERSATION_MODE");
  if (event.command === "mode" && !event.conversationMode)
    throw new Error("INVALID_CONVERSATION_MODE");
  if (event.capture) {
    const capture = event.capture;
    text(capture.sessionId, 200);
    text(capture.utteranceId, 200);
    if (
      !Number.isSafeInteger(capture.segmentIndex) ||
      capture.segmentIndex < 0 ||
      !Number.isFinite(capture.startedAt) ||
      capture.startedAt < 0 ||
      (capture.endedAt !== undefined &&
        (!Number.isFinite(capture.endedAt) ||
          capture.endedAt < capture.startedAt)) ||
      (capture.final !== undefined && typeof capture.final !== "boolean") ||
      (capture.complete !== undefined && typeof capture.complete !== "boolean")
    )
      throw new Error("INVALID_AUDIO_CAPTURE");
  }
  if (event.audioFrame || event.activity) {
    if (
      !event.capture ||
      event.audio ||
      event.text ||
      event.command ||
      (event.audioFrame && event.activity)
    )
      throw new Error("INVALID_MEDIA_INPUT");
  }
  if (
    event.activity &&
    !["start", "end", "quiet", "interrupt"].includes(event.activity)
  )
    throw new Error("INVALID_AUDIO_ACTIVITY");
  if (
    event.silenceMs !== undefined &&
    (event.activity !== "end" ||
      !Number.isFinite(event.silenceMs) ||
      event.silenceMs < 0 ||
      event.silenceMs > 1000)
  )
    throw new Error("INVALID_AUDIO_SILENCE");
  if (event.audioFrame) {
    const frame = event.audioFrame;
    if (
      frame.format !== "pcm16" ||
      frame.sampleRate !== 48000 ||
      frame.channels !== 2 ||
      !Number.isSafeInteger(frame.sequence) ||
      frame.sequence < 0 ||
      typeof frame.pcm !== "string" ||
      frame.pcm.length > 32768 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.pcm)
    )
      throw new Error("INVALID_AUDIO_FRAME");
    const pcm = Buffer.from(frame.pcm, "base64");
    if (
      !pcm.length ||
      pcm.length > 24576 ||
      pcm.length % 4 ||
      pcm.toString("base64") !== frame.pcm
    )
      throw new Error("INVALID_AUDIO_FRAME");
  }
}
