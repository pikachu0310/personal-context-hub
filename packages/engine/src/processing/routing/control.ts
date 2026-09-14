import { parseBotInvocation } from "../immediate/invocation.mjs";
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
