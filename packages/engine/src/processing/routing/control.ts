import { parseBotInvocation } from "../immediate/invocation.mjs";
import { deferredDelegation } from "../coordinator/intent.mjs";
// Only an explicit control phrase can change an existing execution; model replies never do.
export function taskControl(value: string) {
  const body = parseBotInvocation(value)?.body ?? value.trim();
  if (deferredDelegation(value) || /[「『“"]/.test(body)) return;
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
  const natural = body.match(
    /^(?:今の|さっきの|この|その|現在の)\s*(タスク|作業|モック|試作|調査|検証)(?:を|は|に)?\s*([\s\S]+)$/u,
  );
  if (natural) {
    const target = ["タスク", "作業"].includes(natural[1])
      ? undefined
      : natural[1];
    if (
      /^(?:停止|止めて|中止|キャンセル)(?:して|してください|ください)?[。.!！\s]*$/u.test(
        natural[2],
      )
    )
      return {
        action: "stop" as const,
        taskId: undefined,
        instruction: "",
        target,
      };
    if (
      /(?:して|してほしい|してください|変えて|直して|加えて|追加して|にして|調べて|試して)(?:くれる(?:かな)?|ください)?[。.!！?？\s]*$/u.test(
        natural[2],
      )
    )
      return {
        action: "steer" as const,
        taskId: undefined,
        instruction: body,
        target,
      };
  }
}
