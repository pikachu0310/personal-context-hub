import { createHash } from "node:crypto";

export class StudioError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new StudioError(status, message);
};
const text = (value, limit = 6000) =>
  typeof value === "string" ? value.slice(0, limit) : "";
const safe = (value) =>
  text(value).replace(/(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{16,})/gi, "[redacted]");
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Browser and Discord operate the same session and durable queue. This adapter
// receives identity from the authenticated server, never from a command body.
export function createStudioController({
  engine,
  store,
  initialState = {},
  name = "共有スタジオ",
  hudStore,
  readArtifacts,
  previewConfigured,
  previewUrl = (preview) => preview.sharedUrl ?? preview.url,
}) {
  let journal = structuredClone(initialState.studio?.receipts ?? {});
  let tail = Promise.resolve();
  let closing = false;
  const grantOperator = (id) => {
    if (
      Array.isArray(engine.session.operatorUserIds) &&
      !engine.session.operatorUserIds.includes(id)
    )
      engine.session.operatorUserIds.push(id);
  };
  // Restore authority only for identities recorded by this trusted adapter,
  // so a pending browser utterance can still be observed after service restart.
  for (const key of Object.keys(journal)) {
    const match = key.match(/^studio:(browser:[^:]+):/);
    const id = journal[key].actorId ?? match?.[1];
    if (typeof id === "string" && id.startsWith("browser:")) grantOperator(id);
  }
  const save = () => store?.save({ studio: { receipts: journal } });
  const taskFor = (id) =>
    engine.taskQueue?.snapshot().find((task) => task.id === id);
  const snapshot = () => {
    const session = engine.session;
    const statements = [
      ...(session.recentConversation ?? []),
      ...(session.statements ?? []),
    ];
    const unique = new Map(
      statements.map((statement, index) => [
        statement.role === "assistant"
          ? `reply:${statement.sequence ?? statement.sourceSequences?.join(",") ?? index}:${digest(statement.text)}`
          : `user:${statement.sequence ?? statement.id}`,
        statement,
      ]),
    );
    const displayTitle = (value) => {
      const title = safe(value);
      if (title.length <= 32) return title;
      const suffix = title.match(/ · 案 [AB]$/)?.[0] ?? "";
      const quoted = title.match(/[「『]([^」』]{1,30})[」』]/u);
      return (quoted?.[1] ?? `${title.slice(0, 30)}…`) + suffix;
    };
    return {
      name,
      meetingId: session.meetingId,
      revision: session.revision ?? 0,
      connected: !closing,
      capabilities: {
        preview: previewConfigured ?? null,
        files: Boolean(readArtifacts),
      },
      minutes: safe(session.minutes),
      statements: [...unique.values()]
        .sort(
          (a, b) =>
            (a.sequence ?? Math.max(0, ...(a.sourceSequences ?? []))) +
            (a.role === "assistant" ? 0.5 : 0) -
            ((b.sequence ?? Math.max(0, ...(b.sourceSequences ?? []))) +
              (b.role === "assistant" ? 0.5 : 0)),
        )
        .slice(-80)
        .map((statement) => ({
          id: statement.id,
          sequence: statement.sequence,
          text: safe(statement.text),
          speaker:
            text(statement.speakerName, 80) ||
            (statement.role === "assistant" ? "井戸Bot" : "参加者"),
          at: statement.startedAt,
        })),
      tasks: (engine.taskQueue?.snapshot() ?? []).map((task) => ({
        id: task.id,
        title: displayTitle(task.title),
        request: safe(task.request),
        state: task.state,
        createdAt: task.createdAt,
        controlVersion: task.controlVersion ?? 0,
        specRevision: task.specRevision ?? 1,
        runRevision: task.runRevision ?? 0,
        resultSpecRevision: task.resultMetadata?.specRevision,
        resultRunRevision: task.resultMetadata?.runRevision,
        result: safe(task.result),
        verification: safe(task.resultMetadata?.verification),
        acceptanceCriteria: (task.acceptanceCriteria ?? []).map((criterion) =>
          safe(
            typeof criterion === "string"
              ? criterion
              : JSON.stringify(criterion),
          ),
        ),
        sourceSequences: task.sourceSequences ?? [],
        instructions: (task.specHistory?.length
          ? task.specHistory
          : [...(task.steeredInstructions ?? []), ...(task.instructions ?? [])]
        )
          .slice(-10)
          .map((instruction) => ({
            text: safe(
              typeof instruction === "string" ? instruction : instruction.text,
            ),
            specRevision: instruction.specRevision,
          })),
        preview: task.preview
          ? {
              state: task.preview.state,
              runRevision: task.preview.runRevision,
              specRevision: task.preview.specRevision,
              browserVerified: task.preview.browserVerified === true,
              verification: safe(task.preview.verification),
              expiresAt: task.preview.expiresAt,
              confirmations: (task.preview.confirmations ?? []).map(
                ({ userId, at }) => ({ userId, at }),
              ),
              url:
                task.preview.state === "available" &&
                task.preview.specRevision === (task.specRevision ?? 1) &&
                task.preview.runRevision === task.runRevision
                  ? previewUrl(task.preview, task)
                  : undefined,
            }
          : undefined,
      })),
      activity: hudStore?.snapshot().events.slice(-80) ?? [],
    };
  };
  const execute = async (command, actor) => {
    if (closing) fail(503, "エンジンを停止しています。");
    if (!actor?.id || actor.role !== "operator")
      fail(403, "操作用の接続が必要です。");
    grantOperator(actor.id);
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(command?.id ?? ""))
      fail(400, "送信IDが不正です。");
    if (command.meetingId !== engine.session.meetingId)
      fail(409, "会議が切り替わりました。最新の画面を開いてください。");
    // The random request ID remains stable across a browser/server reconnect,
    // even when a newly authenticated participant gets a new session identity.
    const key =
      Object.keys(journal).find((candidate) =>
        candidate.endsWith(`:${command.id}`),
      ) ?? `studio:request:${command.id}`;
    const fingerprint = digest(command);
    let receipt = journal[key];
    if (receipt && receipt.fingerprint !== fingerprint)
      fail(409, "同じ送信IDで内容を変更できません。");
    if (receipt?.result) {
      await save();
      return receipt.result;
    }
    if (!receipt) {
      if (Object.keys(journal).length >= 5000)
        fail(503, "この会議の送信上限に達しました。");
      receipt = journal[key] = {
        fingerprint,
        pending: true,
        actorId: actor.id,
      };
      try {
        await save();
      } catch (error) {
        delete journal[key];
        throw error;
      }
    }
    let result;
    const queue = engine.taskQueue;
    if (["create", "variants"].includes(command.type)) {
      if (!queue) fail(409, "作業実行が有効になっていません。");
      const request = text(command.text).trim();
      if (!request) fail(400, "作りたいものを入力してください。");
      const criteria = text(command.criteria, 2000)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 20);
      const variants =
        command.type === "variants"
          ? [
              text(command.variantA, 1000).trim(),
              text(command.variantB, 1000).trim(),
            ]
          : [""];
      if (command.type === "variants" && variants.some((variant) => !variant))
        fail(400, "比較する二つの方向を入力してください。");
      const taskIds = [];
      for (const [index, variant] of variants.entries()) {
        const requestKey = `${key}:${index}`;
        let existing = queue.getReceipt(requestKey);
        if (!existing) {
          const accepted = await queue.enqueueDurable({
            requestKey,
            title:
              (text(command.title, 100).trim() || request.slice(0, 50)) +
              (variant ? ` · 案 ${index === 0 ? "A" : "B"}` : ""),
            request: variant
              ? `${request}\n比較案 ${index === 0 ? "A" : "B"}: ${variant}`
              : request,
            context: engine.session.getContextSnapshot(),
            meetingId: engine.session.meetingId,
            kind: "implementation",
            complexity: "standard",
            acceptanceCriteria: criteria,
            sourceSequences: (engine.session.statements ?? [])
              .slice(-20)
              .map((statement) => statement.sequence),
            specRevision: 1,
          });
          if (!accepted)
            fail(
              429,
              "実行待ちがいっぱいです。少し待って同じ依頼を再送してください。",
            );
          existing = queue.getReceipt(requestKey);
        }
        taskIds.push(existing.id);
      }
      result = { type: "accepted", taskIds };
    } else if (
      ["follow", "stop", "confirm", "preview"].includes(command.type)
    ) {
      if (!queue) fail(409, "作業実行が有効になっていません。");
      const task = taskFor(command.taskId);
      if (!task) fail(404, "対象の作業が見つかりません。");
      const previous = task.controlReceipts?.[key];
      if (previous) result = previous;
      else {
        if (
          command.specRevision !== (task.specRevision ?? 1) ||
          command.controlVersion !== (task.controlVersion ?? 0)
        )
          fail(
            409,
            "別の参加者が作業を更新しました。最新の内容を確認して再送してください。",
          );
        if (command.type === "preview") {
          if (
            !Number.isInteger(command.runRevision) ||
            command.runRevision !== task.runRevision
          )
            fail(409, "この成果は古い版です。");
          if (!(await queue.restartPreview(task.id, command.runRevision)))
            fail(
              409,
              "プレビューを開けませんでした。起動設定と最新の仕様を確認してください。",
            );
          result = { type: "preview-opened" };
        } else if (command.type === "confirm") {
          if (
            !Number.isInteger(command.runRevision) ||
            command.runRevision !== task.runRevision
          )
            fail(409, "表示していた成果は古い版です。");
          if (
            !(await queue.confirmPreview(
              task.id,
              command.runRevision,
              actor.id,
            ))
          )
            fail(
              409,
              "この版のプレビューは確認できません。最新の成果を開いてください。",
            );
          await queue.persist({ strict: true });
          result = { type: "confirmed" };
        } else {
          const content =
            command.type === "stop" ? "停止" : text(command.text).trim();
          if (!content) fail(400, "変更したい内容を入力してください。");
          result = await queue.handleTaskMessageDurable({
            taskId: task.id,
            userId: actor.id,
            ownerUserId: actor.id,
            content,
            requestKey: key,
            expectedControlVersion: command.controlVersion,
          });
          if (!result || result.type === "superseded")
            fail(409, "対象の作業が更新されました。");
          if (result.type === "full")
            fail(429, "追加指示がいっぱいです。少し待ってください。");
          if (result.persisted === false)
            fail(
              503,
              "停止しましたが保存を確認できません。同じ操作を再送してください。",
            );
        }
      }
    } else if (command.type === "say") {
      const content = text(command.text).trim();
      if (!content) fail(400, "発言を入力してください。");
      const previous = engine.session.statements?.find(
        (statement) => statement.requestKey === key,
      );
      if (!previous) {
        // Persist before dispatch. After a crash without a retained statement,
        // never silently replay an input that may already have triggered work.
        if (receipt.dispatched)
          fail(
            409,
            "この発言の反映は未確認です。会話を確認してから新しく送信してください。",
          );
        receipt.dispatched = true;
        await save();
        await engine.input.accept({
          type: "text",
          text: content,
          id: command.id,
          sessionId: command.meetingId,
          actor,
          metadata: {
            requestKey: key,
            taskEligible: true,
            requestReply: command.ask === true,
          },
        });
      }
      result = { type: "spoken" };
    } else fail(400, "対応していない操作です。");
    receipt.result = result;
    delete receipt.pending;
    await save();
    return result;
  };
  return {
    snapshot,
    async artifacts(taskId, revision, fileId) {
      const task = taskFor(taskId);
      if (!task) fail(404, "対象の作業が見つかりません。");
      if (!readArtifacts)
        fail(404, "この接続では成果ファイルを取得できません。");
      return readArtifacts(task, revision, fileId);
    },
    command(command, actor) {
      const pending = tail.then(() => execute(command, actor));
      tail = pending.catch(() => {});
      return pending;
    },
    async close() {
      closing = true;
      await tail;
    },
  };
}
