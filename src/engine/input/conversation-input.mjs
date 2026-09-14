import { mayReplyImmediately } from "../observation/participation.mjs";

// Replaceable policy: trusted adapter metadata can explicitly defer a question.
// The recognized words do not supply identity, permissions or delivery IDs.
export function classifyConversationInput(statement) {
  const addressed = mayReplyImmediately(statement);
  return {
    priority:
      statement.priority === "normal"
        ? "normal"
        : statement.priority === "immediate" || addressed
          ? "immediate"
          : "normal",
    replyPolicy: addressed ? "answer" : "observe",
  };
}

export function statementEvent(statement, classification) {
  return {
    id: `statement:${statement.meetingId}:${statement.id}`,
    type: "statement",
    ...classification,
    statement: structuredClone(statement),
  };
}
