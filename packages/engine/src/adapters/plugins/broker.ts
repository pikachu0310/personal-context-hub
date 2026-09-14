import type {
  ConversationInput,
  InputContext,
} from "../../../../common/src/contracts/plugins.js";
import { text, type Task } from "../../../../common/src/contracts/protocol.js";
import { Contexts } from "../../management/contexts.js";
import { Identities } from "../../management/identities.js";
import type { Workspace } from "../../output/queries/workspace.js";
import type { Repository } from "../../ports/repository.js";
import type { InputRouter } from "../../processing/routing/input.js";
import type { Plugins } from "./host.js";
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
        !config.meetingId ||
        !config.projectId
      )
        throw new Error("PERMISSION_DENIED");
      return this.store
        .list<Task>("task")
        .filter(
          (task) =>
            task.meetingId === config.meetingId &&
            task.projectId === config.projectId,
        );
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
      const event = input as unknown as ConversationInput;
      validateMediaInput(event);
      if (
        (event.audioFrame || event.activity) &&
        !plugin.manifest?.capabilities.includes("audio-stream")
      )
        throw new Error("PERMISSION_DENIED");
      text(event.eventId, 200);
      text(event.meetingId, 100);
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
        const config = this.store.get<{
          meetingId: string;
          projectId?: string;
        }>("config", pluginId);
        if (
          !config ||
          config.meetingId !== event.meetingId ||
          config.projectId !== event.projectId
        )
          throw new Error("INPUT_BINDING_MISMATCH");
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
            if (context.valid()) await plugin.request("output", { output });
          },
          publish: (event) => {
            if (context.valid()) this.plugins().publish(event);
          },
        };
      }
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
  if (event.activity && !["start", "end", "quiet"].includes(event.activity))
    throw new Error("INVALID_AUDIO_ACTIVITY");
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
