import {
  parseBotInvocation,
  invocationAcknowledgement,
} from "./invocation.mjs";
const QUOTED = /「[^」]*」|『[^』]*』|"[^"\n]*"|`[^`]*`/gu;

export function isBotAddressed(text) {
  return Boolean(parseBotInvocation(text));
}

export function mayReplyImmediately(statement, enabled = true) {
  return (
    statement?.requestReply === true ||
    Boolean(enabled && isBotAddressed(statement?.text))
  );
}

function uncertain(text) {
  return /(?:まだ|あとで|後で|今は|今回は).{0,24}(?:不要|しない|やらない|待|保留|決め|決ま|検討)|(?:しなくて|やらなくて|始めなくて)(?:いい|よい)|(?:かも|かな[。？?\s]*$|どうしよう|検討中|未定|未決定|決まってない|決まっていない|やめよう|保留|見送|必要なら|もし|としたら|したほうが|してもいい|するとしたら)/u.test(
    text,
  );
}

export function explicitDelegation(text, { explicitlyAsked = false } = {}) {
  if (explicitlyAsked && !isBotAddressed(text))
    return explicitDelegation(`井戸Bot、${text}`);
  const unquoted = String(text ?? "")
    .replace(QUOTED, "")
    .trim();
  if (!unquoted || uncertain(unquoted) || invocationAcknowledgement(unquoted))
    return false;
  if (isBotAddressed(unquoted))
    return (
      /(?:して|してください|作って|直して|調べて|確認して|進めて|お願い|頼む|任せる|実行)(?:ほしい|ほしいです|くれる|くれますか|もらえる|もらえますか)?[。！!？?\s]*$|(?:して|作って|直して|調べて|進めて)ください/u.test(
        unquoted,
      ) ||
      /(?:タスク|[Ii]ssue|イシュー).{0,30}(?:立てて|建てて|切って)(?:ください|くれる|ほしい)?[。！!？?\s]*$/u.test(
        unquoted,
      )
    );
  return /(?:井戸(?:Bot|ボット)|ボット|Bot|Codex|コーデックス)(?:に|へ).{0,100}(?:任せよう|任せる|任せて|頼もう|頼む|依頼する|依頼しよう|お願いする|お願いしよう|やってもらおう|やってもらう|進めてもらおう|進めてもらう)[。！!\s]*$/iu.test(
    unquoted,
  );
}

// Clear creation requests can go straight to the same durable queue used by
// the observer. Questions, proposals and ambiguous references still use it.
export function directTaskCreation(text, { explicitlyAsked = false } = {}) {
  if (!explicitDelegation(text, { explicitlyAsked })) return undefined;
  const call =
    parseBotInvocation(text) ?? (explicitlyAsked ? { body: text } : undefined);
  if (!call) return undefined;
  const body = call.body;
  if (/^(?:それ|これ|あれ|さっき|今の|この|その|どちら|どっち)/u.test(body))
    return undefined;
  if (
    !/(?:作って|作成して|実装して|追加して|修正して|直して|調査して|調べて|テストして|(?:タスク|[Ii]ssue|イシュー).{0,30}(?:立てて|建てて|切って))/u.test(
      body,
    )
  )
    return undefined;
  if (
    /(?:かどうか|するか|どちらか|どっちか|(?:作って|作成して|実装して)と)/u.test(
      body,
    )
  )
    return undefined;
  return { body, title: body.replace(/[。！!？?\s]+$/gu, "").slice(0, 80) };
}

// Identity authorization and conversational commitment are separate checks.
// Model-generated titles never turn tentative discussion into an instruction.
export function hasTaskCommitment(
  task,
  statements,
  { autonomousTasks = false } = {},
) {
  if (
    !Array.isArray(task.authorizationSequences) ||
    !task.authorizationSequences.length
  )
    return false;
  if (
    task.executionIntent !== "requested" &&
    !(autonomousTasks && task.executionIntent === "agreed")
  )
    return false;
  const sources = new Map(
    statements.map((statement) => [statement.sequence, statement]),
  );
  const commitments = task.authorizationSequences.map((sequence) =>
    sources.get(sequence),
  );
  const committed = (statement) =>
    explicitDelegation(statement.text, {
      explicitlyAsked: statement.requestReply === true,
    });
  if (
    commitments.some(
      (statement) =>
        !statement ||
        statement.taskEligible === false ||
        !task.sourceSequences.includes(statement.sequence),
    )
  )
    return false;
  if (!commitments.some(committed)) return false;
  // Do not let the model omit a later explicit deferral from its chosen evidence.
  const lastCommitment = Math.max(
    ...commitments.filter(committed).map((statement) => statement.sequence),
  );
  return !statements.some((statement) => {
    if (statement.sequence < lastCommitment || statement.taskEligible === false)
      return false;
    const text = String(statement.text ?? "").replace(QUOTED, "");
    const sameActor = commitments.some(
      (source) =>
        (source.sourceUserId ?? source.userId) ===
        (statement.sourceUserId ?? statement.userId),
    );
    const explicitDeferral =
      sameActor &&
      (isBotAddressed(text) ||
        /^(?:やっぱり|まだ|今は|その(?:作業|タスク))/u.test(text));
    return (
      (task.sourceSequences.includes(statement.sequence) || explicitDeferral) &&
      uncertain(text)
    );
  });
}

export function normalizeTaskTopic(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

export function shouldDeliverObservationReply(
  observation,
  statements,
  recentConversation = [],
) {
  if (
    !observation.shouldReply ||
    !observation.reply ||
    !observation.replySourceSequences?.length
  )
    return false;
  const sources = observation.replySourceSequences.map((sequence) =>
    statements.find((statement) => statement.sequence === sequence),
  );
  if (sources.some((statement) => !statement || statement.handledAction))
    return false;
  if (observation.replyReason === "direct_answer") {
    if (!sources.some((statement) => mayReplyImmediately(statement)))
      return false;
  } else if (
    !["verified_correction", "new_finding"].includes(observation.replyReason)
  )
    return false;
  const normalized = normalizeTaskTopic(observation.reply);
  return !recentConversation.some(
    (item) =>
      item.role === "assistant" && normalizeTaskTopic(item.text) === normalized,
  );
}
