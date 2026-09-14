import type {
  ConversationInput,
  InputContext,
} from "@ido/common/contracts/plugins";
import type { Conversation } from "../conversation.js";
import { invocationAcknowledgement } from "./invocation.mjs";
export async function reply(
  ai: Conversation,
  event: ConversationInput,
  context: InputContext,
  messageId: string,
  content: string,
  question: string,
  failure: (
    error: unknown,
    operation: string,
    model?: string,
    level?: "error" | "warning",
  ) => string,
) {
  let operation = "answer.generate";
  try {
    const answer =
      invocationAcknowledgement(content) ??
      (await ai.answer(event.meetingId, question));
    ai.messages.step(messageId, "reply", "completed");
    if (!context.valid()) {
      ai.messages.step(messageId, "delivery", "interrupted");
      return;
    }
    ai.messages.response(messageId, answer || "回答を生成できませんでした。");
    operation = "text.deliver";
    await context.deliver({
      kind: "reply",
      eventId: event.eventId,
      content: answer || "回答を生成できませんでした。",
      replyTo: event.replyTo,
    });
    if (event.audio && answer) {
      operation = "audio.speak";
      const audio = await ai.speak(answer);
      if (!context.valid()) {
        ai.messages.step(messageId, "delivery", "interrupted");
        return;
      }
      operation = "audio.deliver";
      await context.deliver({
        kind: "audio",
        eventId: event.eventId,
        audio,
        replyTo: event.replyTo,
      });
    }
    ai.messages.step(messageId, "delivery", "completed");
  } catch (error) {
    const model =
      operation === "answer.generate"
        ? "gpt-4.1-mini"
        : operation === "audio.speak"
          ? "gpt-4o-mini-tts"
          : undefined;
    const errorId = failure(
      error,
      operation,
      model,
      operation === "answer.generate" ? "error" : "warning",
    );
    ai.messages.step(
      messageId,
      operation === "answer.generate" ? "reply" : "delivery",
      "failed",
      errorId,
    );
    if (operation === "answer.generate") {
      ai.messages.step(messageId, "delivery", "skipped");
      if (context.valid()) {
        try {
          await context.deliver({
            kind: "reply",
            eventId: event.eventId,
            content: `回答の生成に失敗しました。\nエラーID: ${errorId}（Engineの「エラーログ」で確認できます）`,
            replyTo: event.replyTo,
          });
        } catch (deliveryError) {
          const id = failure(
            deliveryError,
            "text.deliver",
            undefined,
            "warning",
          );
          ai.messages.step(messageId, "delivery", "failed", id);
        }
      }
    }
  }
}
