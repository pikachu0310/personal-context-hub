import { randomUUID } from "node:crypto";
import { discordUserAllowed } from "../../common/src/discord-policy.js";
import { text, type Task, type User } from "../../common/src/protocol.js";
import {
  parseBotInvocation,
  invocationAcknowledgement,
} from "./invocation.mjs";
import type { Store, Meeting } from "./store.js";
import type { Conversation } from "./ai.js";
import type { Plugins } from "./plugins.js";

// Only an explicit control phrase can change an existing execution; model replies never do.
export function taskControl(value: string) {
  const body = parseBotInvocation(value)?.body ?? value.trim();
  const stop = body.match(
    /^(?:(?:今の|さっきの|この|その|現在の)\s*)?(?:タスク|作業)(?:\s+([a-zA-Z0-9_-]{8,100}))?(?:を|の)?\s*(?:停止|止めて|中止|キャンセル)(?:して|してください|ください)?[。.!！\s]*$/u,
  );
  if (stop)
    return { action: "stop" as const, taskId: stop[1], instruction: "" };
  const steer = body.match(
    /^(?:(?:今の|さっきの|この|その|現在の)\s*)?(?:タスク|作業)(?:\s+([a-zA-Z0-9_-]{8,100}))?(?:に|への)?\s*(?:追加指示|追加で|追加|変更指示)[、,:：\s]+([\s\S]+)$/u,
  );
  if (steer)
    return {
      action: "steer" as const,
      taskId: steer[1],
      instruction: steer[2],
    };
  if (
    parseBotInvocation(value) &&
    /^(?:停止|止めて|中止|キャンセル)(?:して|してください|ください)?[。.!！\s]*$/u.test(
      body,
    )
  )
    return { action: "stop" as const, taskId: undefined, instruction: "" };
}

export class DiscordInput {
  constructor(
    readonly store: Store,
    readonly ai: Conversation,
    readonly plugin: Plugins,
    readonly flush: () => void,
  ) {}

  private actor(discordId: string): User | undefined {
    const link = this.store.get<{ userId: string }>("discord-user", discordId);
    if (link) return this.store.user(link.userId);
    const key = `discord-${discordId}`;
    let actor = this.store.get<User>("discord-participant", key);
    if (!actor) {
      actor = { id: key, name: `Discord ${discordId}`, role: "member" };
      this.store.put("discord-participant", key, actor);
    }
    return actor;
  }

  async handle(event: Record<string, unknown>) {
    const config = this.store.get<Record<string, string>>("config", "discord");
    const voiceInput = Boolean(event.audio) || event.source === "voice-command";
    const voiceChannel = this.plugin.voiceChannelId;
    const voiceGeneration = this.plugin.voiceGeneration;
    const allowed = () => {
      const current = this.store.get<Record<string, string>>(
        "config",
        "discord",
      );
      return (
        current &&
        config &&
        current.guildId === config.guildId &&
        current.textChannelId === config.textChannelId &&
        current.meetingId === config.meetingId &&
        current.projectId === config.projectId &&
        event.guildId === current.guildId &&
        discordUserAllowed(current, String(event.userId)) &&
        (voiceInput
          ? Boolean(voiceChannel) &&
            this.plugin.voiceGeneration === voiceGeneration &&
            this.plugin.voiceChannelId === voiceChannel &&
            event.channelId === voiceChannel
          : event.channelId === current.textChannelId)
      );
    };
    const respond = (content: string, file?: string) => {
      if (event.interaction)
        this.plugin.commandResult(String(event.eventId), content, file);
      else if (config) this.plugin.deliver(config.textChannelId, content);
    };
    if (!allowed()) {
      if (event.interaction)
        respond("このチャンネルまたはユーザーは受付対象ではありません。");
      return;
    }
    const actor = this.actor(String(event.userId));
    if (!actor || !config) return;
    const eventId = String(event.eventId || randomUUID());
    if (this.store.get("input", eventId)) return;
    const stage = (value: string) =>
      this.store.put("input", eventId, {
        id: eventId,
        stage: value,
        at: Date.now(),
        meetingId: config.meetingId,
      });
    stage(event.audio ? "transcribing" : "accepted");
    try {
      if (event.command === "context") {
        const meeting = this.store.get<Meeting>("meeting", config.meetingId);
        respond(
          meeting?.summary || "議事録はまだありません。",
          meeting?.summary || "議事録はまだありません。",
        );
        stage("completed");
        return;
      }
      let content =
        typeof event.text === "string" && event.text.trim()
          ? text(event.text)
          : "";
      if (typeof event.audio === "string")
        content = await this.ai.transcribe(Buffer.from(event.audio, "base64"));
      if (!allowed()) {
        stage("discarded");
        return;
      }
      if (!content && event.command !== "stop") {
        stage("ignored");
        return;
      }
      const control =
        event.command === "stop" || event.command === "steer"
          ? {
              action: event.command as "stop" | "steer",
              taskId:
                typeof event.taskId === "string" ? event.taskId : undefined,
              instruction: content,
            }
          : event.command === "ask" || event.command === "task"
            ? undefined
            : taskControl(content);
      const publishTranscript = (meeting: Meeting) =>
        this.plugin.publish(
          "transcript",
          config.meetingId,
          config.textChannelId,
          "🎙 ライブ文字起こし（直近の発言）\n" +
            meeting.messages
              .slice(-12)
              .map(
                (m) =>
                  `${new Date(m.at).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo" })} ${this.store.conversationAuthor(m.authorId)?.name ?? m.authorId}: ${m.text}`,
              )
              .join("\n")
              .slice(-1750),
        );
      if (control) {
        const recorded = this.ai.record(
          config.meetingId,
          actor.id,
          content || "/ido stop",
        );
        recorded.message.stage = "completed";
        this.store.put("meeting", config.meetingId, recorded.meeting);
        publishTranscript(recorded.meeting);
        if (actor.role === "viewer") {
          respond("閲覧者はタスクを操作できません。");
          stage("denied");
          return;
        }
        const candidates = this.store
          .list<Task>("task")
          .filter(
            (t) =>
              t.meetingId === config.meetingId &&
              t.projectId === config.projectId &&
              (control.action === "stop"
                ? ["queued", "assigned", "running", "interrupted"]
                : ["queued", "assigned", "running"]
              ).includes(t.state) &&
              (!control.taskId ||
                t.id === control.taskId ||
                t.id.startsWith(control.taskId)),
          );
        if (candidates.length !== 1) {
          respond(
            candidates.length
              ? `対象を特定してください。/ido ${control.action} の task にIDを指定できます。\n${candidates
                  .slice(0, 8)
                  .map((t) => `${t.id} ${t.text.slice(0, 60)}`)
                  .join("\n")}`
              : "操作できる対象タスクがありません。",
          );
        } else {
          const task = candidates[0];
          this.store.control(
            task.id,
            actor.id,
            control.action,
            control.instruction ? text(control.instruction) : undefined,
          );
          this.flush();
          respond(
            `${task.id}: ${control.action === "stop" ? "停止を受け付けました。" : "同じタスクへ追加指示を送りました。"}`,
          );
        }
        stage("completed");
        return;
      }
      const call =
        event.command === "ask"
          ? { body: content }
          : parseBotInvocation(content);
      let acceptedId = "";
      const analysis = this.ai.process(
        config.meetingId,
        actor.id,
        content,
        event.command === "task" || event.command === "ask"
          ? null
          : config.projectId,
        (meeting) => {
          acceptedId = meeting.messages.at(-1)!.id;
          publishTranscript(meeting);
        },
        () => Boolean(allowed()),
      );
      // Replies run independently of minutes; a simple call needs no answer API.
      const answering = call
        ? (async () => {
            const reply =
              invocationAcknowledgement(content) ??
              (await this.ai.answer(config.meetingId, call.body));
            if (!allowed()) return;
            if (event.interaction)
              respond(reply || "回答を生成できませんでした。");
            else
              this.plugin.deliver(
                config.textChannelId,
                reply || "回答を生成できませんでした。",
              );
            if (event.audio && reply) {
              const audio = await this.ai.speak(reply).catch(() => undefined);
              if (allowed() && audio)
                this.plugin.deliver(
                  config.textChannelId,
                  "",
                  audio,
                  event.speechEpoch,
                );
            }
          })().catch(() => {
            if (allowed())
              respond(
                "回答の生成に失敗しました。OpenAI接続を確認してください。",
              );
          })
        : Promise.resolve();
      const meeting = await analysis;
      if (allowed()) {
        this.plugin.publish(
          "minutes",
          config.meetingId,
          config.textChannelId,
          "📝 議事録\n" + (meeting.summary || "集計中です。"),
        );
        if (event.command === "task" && actor.role !== "viewer") {
          const task = this.store.createTask({
            projectId: config.projectId,
            meetingId: config.meetingId,
            authorId: actor.id,
            requestId: eventId,
            text: content,
            network: false,
          });
          respond(`タスクを追加しました: ${task.id}`);
        }
        this.flush();
      }
      await answering;
      stage(
        meeting.messages.find((m) => m.id === acceptedId)?.stage === "failed"
          ? "failed"
          : "completed",
      );
    } catch {
      stage("failed");
      if (allowed())
        respond(
          "入力の処理に失敗しました。OpenAI接続と会議設定を確認してください。",
        );
    }
  }
}
