import type {
  ConversationInput,
  InputContext,
} from "../../../../common/src/contracts/plugins.js";
import { text, type Task } from "../../../../common/src/contracts/protocol.js";
import type { Meeting } from "../../domain/models.js";
import { normalizeText } from "../../input/text/normalize.js";
import { publishMeeting } from "../../output/text/events.js";
import type { Repository } from "../../ports/repository.js";
import type { Conversation } from "../conversation.js";
import { parseBotInvocation } from "../immediate/invocation.mjs";
import { reply } from "../immediate/reply.js";
import { Tasks } from "../tasks/service.js";
import { taskControl } from "./control.js";
export class InputRouter {
  constructor(
    readonly store: Repository,
    readonly ai: Conversation,
    readonly flush: () => void,
  ) {
    this.tasks = new Tasks(store);
  }
  readonly tasks: Tasks;

  async handle(event: ConversationInput, context: InputContext) {
    const config = { meetingId: event.meetingId, projectId: event.projectId };
    const actor = context.actor;
    const allowed = () =>
      context.valid() && !!this.store.conversationAuthor(actor.id);
    let replyMessageId: string | undefined;
    let acceptedId = "";
    const respond = (content: string, file?: string) => {
      if (replyMessageId) this.ai.messages.response(replyMessageId, content);
      return context.deliver({
        kind: "reply",
        eventId: event.eventId,
        content,
        file,
        replyTo: event.replyTo,
      });
    };
    if (!allowed()) return;
    const eventId = `${context.pluginId}:${event.eventId}`;
    if (this.store.get("input", eventId)) return;
    const errorIds: string[] = [];
    const source = `${context.pluginId}-${event.audio ? "voice" : "text"}`;
    let operation = event.audio ? "audio.transcribe" : "input.process";
    const failure = (
      error: unknown,
      op: string,
      model?: string,
      level: "error" | "warning" = "error",
    ) => {
      const entry = this.store.logError(error, {
        source,
        operation: op,
        eventId: event.eventId,
        meetingId: config.meetingId,
        model,
        level,
      });
      errorIds.push(entry.id);
      return entry.id;
    };
    const reference = (id: string) =>
      `\nエラーID: ${id}（Engineの「エラーログ」で確認できます）`;
    const stage = (value: string) =>
      this.store.put("input", eventId, {
        id: eventId,
        stage: value,
        at: Date.now(),
        meetingId: config.meetingId,
        authorId: actor.id,
        messageId: acceptedId || undefined,
        kind: event.audio ? "audio" : "text",
        text: event.text,
        errorIds,
      });
    stage(event.audio ? "transcribing" : "accepted");
    const reservation = this.ai.minutes.reserve(config.meetingId);
    try {
      if (event.command === "context") {
        const meeting = this.store.get<Meeting>("meeting", config.meetingId);
        await respond(
          meeting?.summary || "議事録はまだありません。",
          meeting?.summary || "議事録はまだありません。",
        );
        stage("completed");
        return;
      }
      let content = normalizeText(event.text);
      if (typeof event.audio === "string") {
        if (this.store.get("meeting", config.meetingId)) {
          const recorded = this.ai.record(config.meetingId, actor.id, "");
          acceptedId = recorded.message.id;
          recorded.message.stage = "transcribing";
          this.store.put("message", acceptedId, recorded.message);
          this.ai.messages.step(acceptedId, "transcription", "running");
          stage("transcribing");
        }
        content = await this.ai.transcribe(Buffer.from(event.audio, "base64"));
      }
      operation = "input.process";
      if (!allowed()) {
        if (acceptedId) {
          this.ai.messages.stage(acceptedId, "discarded");
          this.ai.messages.step(acceptedId, "transcription", "interrupted");
          this.ai.messages.step(acceptedId, "minutes", "skipped");
        }
        stage("discarded");
        return;
      }
      if (!content && event.command !== "stop") {
        if (acceptedId) {
          this.ai.messages.stage(acceptedId, "ignored");
          this.ai.messages.step(acceptedId, "transcription", "skipped");
          this.ai.messages.step(acceptedId, "minutes", "skipped");
        }
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
        publishMeeting(context, "transcript", meeting);
      if (control) {
        const recorded = this.ai.messages.record(
          config.meetingId,
          actor.id,
          content || "stop",
          acceptedId || undefined,
        );
        replyMessageId = recorded.message.id;
        recorded.message.stage = "completed";
        recorded.message.steps!.minutes = { state: "skipped" };
        recorded.message.steps!.transcription = {
          state: event.audio ? "completed" : "skipped",
        };
        this.store.put("meeting", config.meetingId, recorded.meeting);
        publishTranscript(recorded.meeting);
        if (actor.role === "viewer") {
          await respond("閲覧者はタスクを操作できません。");
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
          await respond(
            candidates.length
              ? `対象を特定してください。タスクIDを指定できます。\n${candidates
                  .slice(0, 8)
                  .map((t) => `${t.id} ${t.text.slice(0, 60)}`)
                  .join("\n")}`
              : "操作できる対象タスクがありません。",
          );
        } else {
          const task = candidates[0];
          this.tasks.control(
            task.id,
            actor.id,
            control.action,
            control.instruction ? text(control.instruction) : undefined,
          );
          this.flush();
          await respond(
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
      const analysis = this.ai.process(
        config.meetingId,
        actor.id,
        content,
        event.command === "task" || event.command === "ask"
          ? null
          : config.projectId,
        (meeting) => {
          acceptedId ||= meeting.messages.at(-1)!.id;
          replyMessageId = acceptedId;
          publishTranscript(meeting);
        },
        () => Boolean(allowed()),
        { source, eventId: event.eventId },
        acceptedId || undefined,
        reservation,
      );
      // Replies run independently of minutes; a simple call needs no answer API.
      this.ai.messages.step(
        acceptedId,
        "transcription",
        event.audio ? "completed" : "skipped",
      );
      this.ai.messages.step(acceptedId, "reply", call ? "running" : "skipped");
      this.ai.messages.step(
        acceptedId,
        "delivery",
        call ? "running" : "skipped",
      );
      const answering = call
        ? reply(
            this.ai,
            event,
            context,
            acceptedId,
            content,
            call.body,
            failure,
          )
        : Promise.resolve();
      // Settle both branches on failure without delaying successful minutes.
      const meeting = await analysis.catch(async (error) => {
        await Promise.allSettled([answering]);
        throw error;
      });
      const accepted = meeting.messages.find((m) => m.id === acceptedId);
      if (accepted?.errorId) errorIds.push(accepted.errorId);
      if (allowed()) {
        if (accepted?.stage === "failed")
          await respond(
            "議事録の生成に失敗しました。" +
              (accepted.errorId ? reference(accepted.errorId) : ""),
          );
        publishMeeting(context, "minutes", meeting);
        if (event.command === "task" && actor.role !== "viewer") {
          const task = this.tasks.createTask({
            projectId: config.projectId!,
            meetingId: config.meetingId,
            authorId: actor.id,
            requestId: eventId,
            text: content,
            network: false,
          });
          await respond(`タスクを追加しました: ${task.id}`);
        }
        this.flush();
      }
      await answering;
      stage(
        accepted?.stage === "failed"
          ? "failed"
          : errorIds.length
            ? "partial"
            : "completed",
      );
    } catch (error) {
      const errorId = failure(
        error,
        operation,
        operation === "audio.transcribe" ? "gpt-4o-mini-transcribe" : undefined,
      );
      if (operation === "audio.transcribe") {
        const { message } = this.ai.messages.record(
          config.meetingId,
          actor.id,
          "",
          acceptedId || undefined,
        );
        message.stage = "failed";
        message.errorId = errorId;
        message.steps!.transcription = { state: "failed", errorId };
        message.steps!.minutes = { state: "skipped" };
        this.store.put("message", message.id, message);
      }
      stage("failed");
      if (allowed())
        await respond("入力の処理に失敗しました。" + reference(errorId));
    } finally {
      reservation.release();
    }
  }
}
