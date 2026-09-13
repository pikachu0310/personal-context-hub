import { requestedVoiceModel } from "./model-policy.mjs";
import { deliverTaskResults } from "./output/task-results.mjs";
import { randomUUID } from "node:crypto";
import {
  VoiceServiceError,
  voiceErrorCode,
  voiceErrorMessage,
} from "./errors.mjs";
import {
  boundText,
  withTimeout,
  DEFAULT_STAGE_TIMEOUTS,
  MAX_RESPONSE_CHARACTERS,
} from "./shared.mjs";
import { plainPresentation } from "./output/presentation.mjs";
const UNCONFIRMED_INSTRUCTION_PREFIX =
  "中断前の追加指示は完了未確認です。履歴と作業場所を確認し、実行済みの外部操作を繰り返さず、未完了分だけ続けてください。\n";

function retainInterruptedInstruction(task, entry, uncertain = true) {
  const text = typeof entry === "string" ? entry : entry?.text;
  if (!text) return;
  task.instructions.unshift({
    id: typeof entry === "object" ? entry.id : randomUUID(),
    ...(typeof entry === "object" && entry.source
      ? { source: structuredClone(entry.source) }
      : {}),
    text:
      uncertain && !text.startsWith(UNCONFIRMED_INSTRUCTION_PREFIX)
        ? UNCONFIRMED_INSTRUCTION_PREFIX + text
        : text,
  });
  task.additionalInstruction = undefined;
  task.additionalInstructionSource = undefined;
}
import { formatVerificationEvidence } from "./evidence.mjs";
export class TaskQueue {
  constructor({
    presentation = plainPresentation,
    runTask,
    steerTask,
    confirmPreview,
    invalidatePreview = async () => {},
    postText,
    createTaskThread,
    logger = console,
    concurrency = 2,
    maximumPendingTasks = 10,
    taskTimeoutMs = 3_600_000,
    checkpoint = async () => undefined,
    onResult = async () => undefined,
    applyTask,
    agentTeam,
    reviewTask,
    progressIntervalMs = 10_000,
    checkpointTimeoutMs = DEFAULT_STAGE_TIMEOUTS.posting,
  }) {
    this.presentation = presentation;
    this.checkpoint = checkpoint;
    this.stateWriting = Promise.resolve();
    this.onResult = onResult;
    this.applyTaskChanges = applyTask;
    this.agentTeam = agentTeam;
    this.reviewTask = reviewTask;
    this.progressIntervalMs = progressIntervalMs;
    this.checkpointTimeoutMs = checkpointTimeoutMs;
    this.tasks = new Map();
    this.runTask = runTask;
    this.steerTask = steerTask;
    this.confirmPreviewVersion = confirmPreview;
    this.invalidatePreview = invalidatePreview;
    this.postText = postText;
    this.createTaskThread = createTaskThread;
    this.logger = logger;
    this.concurrency = concurrency;
    this.maximumPendingTasks = maximumPendingTasks;
    this.taskTimeoutMs = taskTimeoutMs;
    this.queue = [];
    this.running = new Set();
    this.deliveries = new Set();
    this.notifications = new Set();
    this.tasksByThreadId = new Map();
    this.active = 0;
    this.closed = false;
    this.stopping = undefined;
    this.shutdownController = new AbortController();
  }

  enqueue(task) {
    return Boolean(this.#enqueueTask(task));
  }

  async enqueueDurable(task) {
    const accepted = this.#enqueueTask(task);
    if (!accepted) return false;
    if (accepted.state === "cancelled") {
      await this.persist({ strict: true });
      return true;
    }
    await accepted.acceptancePromise;
    return true;
  }

  #enqueueTask(task) {
    if (this.closed) return false;
    let previous;
    if (task.requestKey) {
      previous = [...this.tasks.values()].find(
        (candidate) => candidate.requestKey === task.requestKey,
      );
      if (
        previous &&
        (!previous.receiptFailed ||
          previous.state === "cancelled" ||
          previous.executing)
      )
        return previous;
    }
    if (this.queue.length + this.active >= this.maximumPendingTasks)
      return false;
    let id = previous?.id ?? task.id;
    if (id && this.tasks.has(id) && this.tasks.get(id) !== previous)
      throw new Error("Task ID already belongs to another request");
    if (!id)
      do {
        id = randomUUID().slice(0, 8);
      } while (this.tasks.has(id));
    const queuedTask = {
      ...task,
      id,
      createdAt: Date.now(),
      instructions: [],
      cancelled: false,
      executing: false,
      state: "queued",
    };
    queuedTask.issueId ??= queuedTask.id;
    this.agentTeam?.assign(queuedTask, this.tasks.values());
    this.tasks.set(queuedTask.id, queuedTask);
    queuedTask.checkpoint = () => this.persist({ strict: true });
    queuedTask.acceptancePromise = this.persist({ strict: true }).catch(
      (error) => {
        queuedTask.receiptFailed = true;
        throw error;
      },
    );
    queuedTask.surfacePromise = queuedTask.acceptancePromise.then(() =>
      withTimeout(
        () => {
          if (this.closed || queuedTask.cancelled)
            throw new VoiceServiceError(
              "TASK_CANCELLED",
              "Task cancelled before surface creation",
              "開始前に中止しました。",
            );
          return this.createTaskThread(queuedTask);
        },
        DEFAULT_STAGE_TIMEOUTS.posting,
        "creating task thread",
        this.shutdownController.signal,
      ),
    );
    void queuedTask.surfacePromise
      .then((surface) => {
        queuedTask.surface = surface;
        if (surface?.threadId)
          this.tasksByThreadId.set(String(surface.threadId), queuedTask);
        if (!this.closed && queuedTask.cancelled && !queuedTask.executing)
          void this.#markCancelled(surface, queuedTask);
        void this.persist();
      })
      .catch(() => undefined);
    this.queue.push(queuedTask);
    this.#drain();
    return queuedTask;
  }

  snapshot({ includeInstruction, receiptTask, receiptKey } = {}) {
    return [...this.tasks.values()].map((task) => ({
      id: task.id,
      title: task.title,
      request: task.request,
      requestKey: task.requestKey,
      receiptFailed:
        task === receiptTask && includeInstruction ? false : task.receiptFailed,
      context: task.context,
      sourceSequences: structuredClone(task.sourceSequences),
      sourceStatements: structuredClone(task.sourceStatements),
      acceptanceCriteria: structuredClone(task.acceptanceCriteria),
      kind: task.kind,
      complexity: task.complexity,
      modelSelection: structuredClone(task.modelSelection),
      usage: structuredClone(task.usage),
      usageHistory: structuredClone(task.usageHistory),
      specRevision: task.specRevision ?? 1,
      activeSpecRevision: task.activeSpecRevision,
      steeredInstructions: structuredClone(task.steeredInstructions ?? []),
      issueId: task.issueId,
      assignedAgentId: task.assignedAgentId,
      assignedAgentName: task.assignedAgentName,
      assignedAgentTransport: task.assignedAgentTransport,
      assignedAgentOwnerUserId: task.assignedAgentOwnerUserId,
      assignedAt: task.assignedAt,
      assignmentReason: task.assignmentReason,
      reassignments: structuredClone(task.reassignments ?? []),
      remoteExecution: task.remoteExecution,
      createdAt: task.createdAt,
      meetingId: task.meetingId,
      state: task.state,
      instructions: structuredClone(
        task.instructions
          .filter((entry) => !entry?.pending || entry === includeInstruction)
          .map((entry) =>
            typeof entry === "string"
              ? entry
              : {
                  id: entry.id,
                  text: entry.text,
                  requestKey: entry.requestKey,
                  delivery: entry.delivery,
                  specRevision: entry.specRevision,
                  modelSelection: entry.modelSelection,
                  receivedAt: entry.receivedAt,
                  sourceSequences: entry.sourceSequences,
                  source: structuredClone(entry.source),
                },
          ),
      ),
      controlReceipts: structuredClone(
        Object.fromEntries(
          Object.entries(task.controlReceipts ?? {}).filter(
            ([key]) =>
              !task.pendingControlReceipts?.has(key) ||
              (task === receiptTask && key === receiptKey),
          ),
        ),
      ),
      cancelled: task.cancelled,
      controlVersion: task.controlVersion ?? 0,
      execution: structuredClone(task.execution),
      // Legacy state field, carried through without interpreting the backend ID.
      codexThreadId: task.codexThreadId,
      workingDirectory: task.workingDirectory,
      baseCommit: task.baseCommit,
      baselineTree: task.baselineTree,
      baselineFingerprint: task.baselineFingerprint,
      applied: task.applied,
      appliedRevision: task.appliedRevision,
      appliedFileState: structuredClone(task.appliedFileState),
      threadId: task.surface?.threadId ?? task.threadId,
      starterId: task.surface?.starterId ?? task.starterId,
      surfaceType: task.surface?.surfaceType ?? task.surfaceType,
      result: task.result,
      resultMetadata: structuredClone(task.resultMetadata),
      artifacts: structuredClone(task.artifacts),
      preview: structuredClone(task.preview),
      profile: structuredClone(task.profile),
      evidence: structuredClone(task.evidence),
      additionalInstruction: task.additionalInstruction,
      additionalInstructionSource: structuredClone(
        task.additionalInstructionSource,
      ),
      peerReviews: structuredClone(task.peerReviews ?? []),
      peerReviewCompletedRevisions: structuredClone(
        task.peerReviewCompletedRevisions ?? [],
      ),
      resultDeliveryPending: task.resultDeliveryPending,
      resultDeliveries: structuredClone(task.resultDeliveries ?? []),
      runRevision: task.runRevision,
    }));
  }

  persist({ strict = false, onSaved, onFailure, ...snapshotOptions } = {}) {
    const operation = this.stateWriting.then(async () => {
      try {
        await withTimeout(
          () => this.checkpoint(this.snapshot(snapshotOptions)),
          this.checkpointTimeoutMs,
          "saving task state",
        );
        onSaved?.();
        return true;
      } catch (error) {
        onFailure?.();
        this.#log("task_checkpoint_failed", {});
        if (strict)
          throw new VoiceServiceError(
            "TASK_STATE_SAVE_FAILED",
            "Task receipt could not be saved",
            "依頼を保存できなかったため作業を開始していません。保存先を確認して再試行してください。",
            { cause: error },
          );
        return false;
      }
    });
    this.stateWriting = operation.catch(() => undefined);
    return operation;
  }

  async restore(records, restoreSurface) {
    for (const record of records ?? []) {
      if (!record?.id) continue;
      const task = {
        ...record,
        instructions: structuredClone(record.instructions ?? []),
        executing: false,
      };
      task.issueId ??= task.id;
      this.agentTeam?.assign(task, this.tasks.values());
      if (
        task.preview &&
        ["starting", "available"].includes(task.preview.state)
      )
        task.preview.state = "restart-unverified";
      for (const entry of task.instructions) {
        if (entry?.delivery === "sending" || entry?.delivery === "uncertain") {
          if (!entry.text.startsWith(UNCONFIRMED_INSTRUCTION_PREFIX))
            entry.text = UNCONFIRMED_INSTRUCTION_PREFIX + entry.text;
          delete entry.delivery;
        }
      }
      if (["running", "queued", "interrupted"].includes(task.state)) {
        for (const entry of task.steeredInstructions ?? []) {
          if (
            entry.runRevision === task.runRevision &&
            !task.instructions.some(
              (instruction) => instruction?.id === entry.id,
            )
          )
            retainInterruptedInstruction(task, entry);
        }
      }
      if (
        ["running", "queued", "interrupted"].includes(task.state) &&
        task.additionalInstruction
      ) {
        retainInterruptedInstruction(task, {
          text: task.additionalInstruction,
          source: task.additionalInstructionSource,
        });
      }
      if (["running", "queued"].includes(task.state))
        task.state = "interrupted";
      task.resultDeliveries ??= [];
      if (
        task.resultDeliveryPending &&
        !task.resultDeliveries.length &&
        task.result
      ) {
        task.resultDeliveries.push({
          result: task.result,
          artifacts: task.artifacts,
          evidence: task.evidence,
          peerReview: task.peerReviews?.find(
            ({ runRevision }) => runRevision === task.runRevision,
          ),
          state: task.state,
          elapsedMs: Date.now() - task.createdAt,
          pendingInstructions: task.instructions.length,
          nextStep: 0,
        });
      }
      task.cancelled = true;
      task.checkpoint = () => this.persist({ strict: true });
      task.restoreSurface = restoreSurface;
      this.tasks.set(task.id, task);
      if (task.threadId) this.tasksByThreadId.set(String(task.threadId), task);
      if (
        ["completed", "failed", "cancelled"].includes(task.state) &&
        !task.resultDeliveryPending
      )
        continue;
      try {
        const surface = await this.#loadRestoredSurface(task);
        await withTimeout(
          () => surface?.update?.({ state: task.state }),
          DEFAULT_STAGE_TIMEOUTS.posting,
          "refreshing restored task",
          this.shutdownController.signal,
        );
      } catch {
        this.#log("task_surface_restore_failed", { taskId: task.id });
      }
    }
    await this.persist();
  }

  #loadRestoredSurface(task) {
    if (task.surface) return Promise.resolve(task.surface);
    if (!task.restoreSurface)
      return Promise.reject(new Error("No saved task surface"));
    if (!task.restoringSurface) {
      task.restoringSurface = withTimeout(
        async (signal) => {
          try {
            return await task.restoreSurface(task);
          } catch (error) {
            if (task.threadId && error?.code !== "TASK_SURFACE_MISSING")
              throw new VoiceServiceError(
                "TASK_SURFACE_UNAVAILABLE",
                "Could not restore the task result thread",
                "結果の送信先を取得できませんでした。接続状態と権限を確認して、同じタスクで再試行してください。",
                { cause: error },
              );
            signal.throwIfAborted();
            if (task.executing && task.cancelled)
              throw new VoiceServiceError(
                "TASK_CANCELLED",
                "Task stopped during thread recovery",
                "結果スレッドの復旧中に停止しました。",
              );
            return this.createTaskThread(task);
          }
        },
        DEFAULT_STAGE_TIMEOUTS.posting,
        "restoring task thread",
        this.shutdownController.signal,
      )
        .then((surface) => {
          if (!surface) throw new Error("Saved task surface unavailable");
          task.surface = surface;
          if (surface.threadId)
            this.tasksByThreadId.set(String(surface.threadId), task);
          if (!this.closed && task.state === "cancelled" && !task.executing)
            void this.#markCancelled(surface, task);
          return surface;
        })
        .finally(() => {
          task.restoringSurface = undefined;
        });
    }
    return task.restoringSurface;
  }

  list() {
    return [...this.tasks.values()].map(
      ({
        id,
        title,
        state,
        surface,
        threadId,
        createdAt,
        controlVersion,
        preview,
        specRevision,
        resultDeliveryPending,
        issueId,
        assignedAgentId,
        assignedAgentName,
      }) => ({
        id,
        issueId: issueId ?? id,
        title,
        state,
        assignedAgentId,
        assignedAgentName,
        resultDeliveryPending: Boolean(resultDeliveryPending),
        createdAt,
        controlVersion: controlVersion ?? 0,
        preview: preview
          ? { state: preview.state, runRevision: preview.runRevision }
          : undefined,
        specRevision: specRevision ?? 1,
        threadId: surface?.threadId ?? threadId,
      }),
    );
  }

  getReceipt(requestKey) {
    if (!requestKey) return undefined;
    const task = [...this.tasks.values()].find(
      (entry) => entry.requestKey === requestKey,
    );
    return task ? { id: task.id, state: task.state } : undefined;
  }

  getTaskResult(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return {
      id: task.id,
      issueId: task.issueId ?? task.id,
      assignedAgentId: task.assignedAgentId,
      assignedAgentName: task.assignedAgentName,
      title: task.title,
      result: task.result,
      runRevision: task.resultMetadata?.runRevision,
      completedAt: task.resultMetadata?.completedAt,
      resultDeliveryPending: Boolean(task.resultDeliveryPending),
      verification:
        task.resultMetadata?.verification ??
        "検証記録: この結果に対応する実行版は未確認",
      currentState: task.state,
      currentRunRevision: task.runRevision,
      specRevision: task.specRevision ?? 1,
      resultSpecRevision: task.resultMetadata?.specRevision,
      superseded: Boolean(
        task.resultMetadata?.specRevision &&
        task.resultMetadata.specRevision !== (task.specRevision ?? 1),
      ),
      threadId: task.surface?.threadId ?? task.threadId,
      meetingId: task.meetingId,
    };
  }

  handleTaskMessage({ taskId, ...message }) {
    const task = this.tasks.get(taskId);
    return this.#handleTaskInstruction(task, message);
  }

  async handleTaskMessageDurable({ taskId, ...message }) {
    const task = this.tasks.get(taskId);
    return this.#awaitControl(
      task,
      this.#handleTaskInstruction(task, message),
      message.requestKey,
    );
  }

  async handleAgentMessageDurable({ taskId, agentId, content, requestKey }) {
    const agent = this.agentTeam?.get(agentId);
    const task = this.tasks.get(taskId);
    if (!agent || !task || agent.id === task.assignedAgentId) return false;
    return this.#awaitControl(
      task,
      this.#handleTaskInstruction(task, {
        userId: `agent:${agent.id}`,
        ownerUserId: `agent:${agent.id}`,
        content,
        requestKey,
        source: {
          type: "agent_review",
          agentId: agent.id,
          agentName: agent.name,
        },
      }),
      requestKey,
    );
  }

  async handleThreadMessageDurable({ threadId, ...message }) {
    const task = this.tasksByThreadId.get(String(threadId));
    return this.#awaitControl(
      task,
      this.#handleTaskInstruction(task, message),
      message.requestKey,
    );
  }

  async #awaitControl(task, result, requestKey) {
    if (!result || ["full", "superseded"].includes(result.type)) return result;
    if (
      result.type === "cancelled" &&
      result.persisted === false &&
      !task.controlPersistenceByKey?.has(requestKey)
    ) {
      delete result.persisted;
      void this.#persistControl(task, result, { requestKey }).catch(
        () => undefined,
      );
    }
    try {
      await (requestKey
        ? task.controlPersistenceByKey?.get(requestKey)
        : task.controlPersistence);
      if (result.type === "cancelled") await task.workerSettlement;
      return result;
    } catch (error) {
      if (result.type === "cancelled") return { ...result, persisted: false };
      throw error;
    }
  }

  #persistControl(
    task,
    result,
    { requestKey, entry, previousState, previousCancelled } = {},
  ) {
    task.controlReceipts ??= {};
    if (entry) entry.pending = true;
    if (requestKey) {
      task.controlReceipts[requestKey] = result;
      task.pendingControlReceipts ??= new Set();
      task.pendingControlReceipts.add(requestKey);
    }
    const saved = this.persist({
      strict: true,
      includeInstruction: entry,
      receiptTask: task,
      receiptKey: requestKey,
      onSaved: () => {
        if (entry) {
          delete entry.pending;
          task.receiptFailed = false;
          task.acceptancePromise = Promise.resolve();
        }
        task.pendingControlReceipts?.delete(requestKey);
      },
      onFailure: () => {
        task.pendingControlReceipts?.delete(requestKey);
        if (entry) {
          task.instructions = task.instructions.filter(
            (candidate) => candidate !== entry,
          );
          task.specRevision = Math.max(
            task.activeSpecRevision ?? 1,
            ...task.instructions.map((item) => item.specRevision ?? 1),
          );
          if (requestKey) delete task.controlReceipts[requestKey];
          if (
            !task.executing &&
            !this.queue.includes(task) &&
            !task.instructions.length
          ) {
            task.state = previousState;
            task.cancelled = previousCancelled;
          }
        } else result.persisted = false;
        void this.persist();
      },
    });
    task.controlPersistence = saved;
    task.instructionBarrier = saved.catch(() => undefined);
    if (requestKey) {
      task.controlPersistenceByKey ??= new Map();
      task.controlPersistenceByKey.set(requestKey, saved);
      void saved
        .finally(() => task.controlPersistenceByKey.delete(requestKey))
        .catch(() => undefined);
    }
    return saved;
  }

  async #waitForInstructionReceipts(task) {
    let current;
    do {
      current = task.instructionBarrier;
      await current;
    } while (current !== task.instructionBarrier);
    await task.steeringPromise;
  }

  #flushSteering(task) {
    if (task.steeringPromise) return task.steeringPromise;
    task.steeringPromise = (async () => {
      if (!this.steerTask || !task.executing || task.controller?.signal.aborted)
        return;
      while (task.instructions.length) {
        const entry = task.instructions[0];
        if (
          entry.pending ||
          entry.delivery ||
          task.cancelled ||
          this.closed ||
          task.controller?.signal.aborted
        )
          break;
        if (typeof entry === "string") break;
        // App Server cannot change a model within an active turn. Preserve a
        // requested switch as the next turn rather than silently ignoring it.
        if (
          entry.modelSelection &&
          entry.modelSelection.model !== task.profile?.model
        )
          break;
        entry.delivery = "sending";
        try {
          await this.persist({ strict: true });
        } catch (error) {
          delete entry.delivery;
          throw error;
        }
        let accepted;
        try {
          accepted = await this.steerTask(task, entry.text);
        } catch {
          entry.delivery = "uncertain";
          if (!entry.text.startsWith(UNCONFIRMED_INSTRUCTION_PREFIX))
            entry.text = UNCONFIRMED_INSTRUCTION_PREFIX + entry.text;
          task.controller?.abort(
            new VoiceServiceError(
              "TASK_STEERING_UNCONFIRMED",
              "The worker did not acknowledge the instruction",
              "追加指示の受け取りを確認できないため作業を中断しました。同じタスクから再開できます。",
            ),
          );
          await this.persist();
          return;
        }
        if (!accepted) {
          delete entry.delivery;
          await this.persist();
          break;
        }
        entry.delivery = "accepted";
        entry.acceptedAt = Date.now();
        task.activeSpecRevision = entry.specRevision;
        task.steeredInstructions ??= [];
        task.steeredInstructions.push({
          ...entry,
          runRevision: task.runRevision,
        });
        task.steeredInstructions = task.steeredInstructions.slice(-30);
        task.instructions = task.instructions.filter((item) => item !== entry);
        if (entry.requestKey && task.controlReceipts?.[entry.requestKey]) {
          task.controlReceipts[entry.requestKey].disposition = "steered";
          task.controlReceipts[entry.requestKey].pendingInstructions =
            task.instructions.length;
        }
        try {
          await this.persist({ strict: true });
        } catch (error) {
          task.controller?.abort(error);
          throw error;
        }
        this.#log("power_task_steered", {
          taskId: task.id,
          specRevision: entry.specRevision,
          steeringMs: entry.acceptedAt - entry.receivedAt,
        });
      }
    })().finally(() => {
      task.steeringPromise = undefined;
    });
    return task.steeringPromise;
  }

  async applyTask(taskId, expectedRevision) {
    const task = this.tasks.get(taskId);
    if (
      !task ||
      task.state !== "completed" ||
      task.executing ||
      (expectedRevision !== undefined &&
        expectedRevision !== task.artifacts?.runRevision) ||
      (task.applied &&
        (!task.appliedRevision ||
          task.appliedRevision === task.artifacts?.runRevision)) ||
      task.remoteExecution ||
      task.artifacts?.remote ||
      !this.applyTaskChanges
    )
      return false;
    if (!(await this.applyTaskChanges(task))) return false;
    await this.persist();
    try {
      const surface = task.surface ?? (await this.#loadRestoredSurface(task));
      await withTimeout(
        () => surface?.update?.({ state: task.state }),
        DEFAULT_STAGE_TIMEOUTS.posting,
        "refreshing applied task",
        this.shutdownController.signal,
      );
    } catch {
      this.#log("task_surface_refresh_failed", { taskId: task.id });
    }
    return true;
  }

  async confirmPreview(taskId, revision, userId) {
    const task = this.tasks.get(taskId);
    if (!task || task.executing || task.state !== "completed") return false;
    return (
      (await this.confirmPreviewVersion?.(task, revision, userId)) ?? false
    );
  }

  async retryResultDelivery() {
    if (this.deliveringResults || this.closed) return;
    this.deliveringResults = true;
    try {
      await Promise.all(
        [...this.tasks.values()]
          .filter((task) => task.resultDeliveryPending)
          .map((task) => this.#deliverTaskResults(task)),
      );
    } finally {
      this.deliveringResults = false;
    }
  }

  #deliverTaskResults(task) {
    if (!task.deliveryPromise) {
      const operation = this.#flushTaskResults(task).finally(() => {
        task.deliveryPromise = undefined;
        this.deliveries.delete(operation);
      });
      task.deliveryPromise = operation;
      this.deliveries.add(operation);
    }
    return task.deliveryPromise;
  }

  #flushTaskResults(task) {
    return deliverTaskResults(task, {
      presentation: this.presentation,
      persist: (options) => this.persist(options),
      loadSurface: (record) => this.#loadRestoredSurface(record),
      onResult: this.onResult,
      signal: this.shutdownController.signal,
      isClosed: () => this.closed,
      log: (event, detail) => this.#log(event, detail),
    });
  }

  handleThreadMessage({ threadId, ...message }) {
    const task = this.tasksByThreadId.get(String(threadId));
    return this.#handleTaskInstruction(task, message);
  }

  #handleTaskInstruction(
    task,
    {
      userId,
      ownerUserId,
      content,
      requestKey,
      expectedControlVersion,
      sourceSequences,
      source,
    },
  ) {
    if (this.closed || userId !== ownerUserId) return false;
    const instruction = boundText(content, this.presentation.maximumText);
    if (!task || !instruction) return false;
    if (requestKey && Object.hasOwn(task.controlReceipts ?? {}, requestKey))
      return task.controlReceipts[requestKey];
    if (
      /^(?:停止|中止|キャンセル|stop|cancel)[!！。\s]*$/iu.test(instruction)
    ) {
      const discardedInstructions = task.instructions.length;
      task.controlVersion = (task.controlVersion ?? 0) + 1;
      task.cancelled = true;
      void this.invalidatePreview(task, "stopped").catch(() =>
        this.#log("preview_stop_failed", { taskId: task.id }),
      );
      task.state = "cancelled";
      task.instructions.length = 0;
      task.cancelledInstructionCount = discardedInstructions;
      this.queue = this.queue.filter((queued) => queued !== task);
      task.controller?.abort(
        new VoiceServiceError(
          "TASK_CANCELLED",
          "Task cancelled by its owner.",
          "本人の操作によりタスクを中止しました。",
        ),
      );
      const result = { type: "cancelled", discardedInstructions };
      void this.#persistControl(task, result, { requestKey }).catch(
        () => undefined,
      );
      if (!task.executing) void this.#markCancelled(task.surface, task);
      return result;
    }
    if (
      expectedControlVersion !== undefined &&
      expectedControlVersion !== (task.controlVersion ?? 0)
    )
      return { type: "superseded" };
    if (
      !task.executing &&
      !this.queue.includes(task) &&
      this.queue.length + this.active >= this.maximumPendingTasks
    )
      return { type: "full" };
    const disposition =
      task.executing || this.queue.includes(task) ? "queued" : "resumed";
    if (task.instructions.length >= 10) return { type: "full" };
    const previousState = task.state;
    const previousCancelled = task.cancelled;
    const entry = {
      id: randomUUID(),
      text: instruction,
      requestKey,
      receivedAt: Date.now(),
      sourceSequences,
      specRevision: (task.specRevision ?? 1) + 1,
      modelSelection: requestedVoiceModel(instruction),
      ...(source ? { source: structuredClone(source) } : {}),
    };
    task.specRevision = entry.specRevision;
    task.instructions.push(entry);
    task.state = task.executing ? "running" : "queued";
    task.cancelled = false;
    const result = {
      type: "instruction",
      disposition,
      pendingInstructions: task.instructions.length,
    };
    void this.#persistControl(task, result, {
      requestKey,
      entry,
      previousState,
      previousCancelled,
    })
      .then(async () => {
        if (this.closed || task.cancelled || !task.instructions.includes(entry))
          return;
        void this.invalidatePreview(task).catch(() =>
          this.#log("preview_stop_failed", { taskId: task.id }),
        );
        if (
          task.executing &&
          (task.controller?.signal.aborted || task.workerFailed)
        )
          task.resumeAfterAbort = true;
        if (task.executing) await this.#flushSteering(task);
        if (!task.executing && !this.queue.includes(task)) {
          if (!task.surface) task.surfacePromise = undefined;
          this.queue.push(task);
          this.#drain();
        } else {
          void Promise.resolve(
            task.surface?.update?.({
              state: task.executing ? "running" : "queued",
              pendingInstructions: task.instructions.length,
            }),
          ).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return result;
  }

  handleVoiceControl(control) {
    const task = this.#voiceControlTask(control);
    return this.#handleTaskInstruction(task, {
      userId: "voice-owner",
      ownerUserId: "voice-owner",
      requestKey: control.requestKey,
      expectedControlVersion: control.expectedControlVersion,
      sourceSequences: control.sourceSequences,
      content: control.type === "stop" ? "停止" : control.instruction,
    });
  }

  async handleVoiceControlDurable(control) {
    const task = this.#voiceControlTask(control);
    return this.#awaitControl(
      task,
      this.#handleTaskInstruction(task, {
        userId: "voice-owner",
        ownerUserId: "voice-owner",
        requestKey: control.requestKey,
        expectedControlVersion: control.expectedControlVersion,
        content: control.type === "stop" ? "停止" : control.instruction,
      }),
      control.requestKey,
    );
  }

  #voiceControlTask(control) {
    let candidates = [...this.tasks.values()];
    if (control?.requestKey) {
      const previous = candidates.find((task) =>
        Object.hasOwn(task.controlReceipts ?? {}, control.requestKey),
      );
      if (previous) return previous;
    }
    if (control?.taskId)
      candidates = candidates.filter((task) => task.id === control.taskId);
    else
      candidates = candidates.filter(
        (task) =>
          !task.cancelled && (task.executing || this.queue.includes(task)),
      );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  stop() {
    if (this.stopping) return this.stopping;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    const queued = this.queue.splice(0);
    this.shutdownController.abort(
      new VoiceServiceError(
        "SERVICE_STOPPED",
        "Voice task queue stopped.",
        "音声サービスを停止しました。",
      ),
    );
    const cancellations = queued.map((task) =>
      Promise.resolve(task.surfacePromise)
        .then((surface) =>
          task.cancelled
            ? this.#markCancelled(surface, task)
            : this.#markInterrupted(surface, task),
        )
        .catch(() => undefined),
    );
    this.stopping = Promise.allSettled([
      ...this.running,
      ...cancellations,
      ...[...this.tasks.values()].flatMap((task) => [
        task.controlPersistence,
        ...(task.controlPersistenceByKey?.values() ?? []),
      ]),
    ]).then(async () => {
      await Promise.allSettled([...this.notifications, ...this.deliveries]);
      return this.persist({ strict: true });
    });
    return this.stopping;
  }

  #drain() {
    while (
      !this.closed &&
      this.active < this.concurrency &&
      this.queue.length
    ) {
      if (this.agentTeam) {
        for (const queued of this.queue) {
          const assigned = this.agentTeam.get(queued.assignedAgentId);
          if (assigned?.online !== false) continue;
          this.agentTeam.reassign(queued, this.tasks.values(), [
            queued.assignedAgentId,
          ]);
        }
      }
      const index = this.agentTeam
        ? this.queue.findIndex((task) => this.agentTeam.canRun(task))
        : 0;
      if (index < 0) break;
      const [task] = this.queue.splice(index, 1);
      const agentLease = this.agentTeam
        ? { assignedAgentId: task.assignedAgentId }
        : undefined;
      if (this.agentTeam && !this.agentTeam.start(agentLease)) {
        this.queue.splice(index, 0, task);
        break;
      }
      task.agentExecutionLease = agentLease;
      this.active += 1;
      const execution = this.#execute(task);
      this.running.add(execution);
      void execution.finally(() => {
        this.running.delete(execution);
        this.agentTeam?.finish(task.agentExecutionLease ?? agentLease);
        delete task.agentExecutionLease;
        this.active -= 1;
        this.#drain();
      });
    }
  }

  resume() {
    this.#drain();
  }

  async #execute(task) {
    task.executing = true;
    const startedAt = Date.now();
    let taskSurface;
    let postTaskText;
    let workerSucceeded = false;
    let workerInvoked = false;
    let consumedInstruction;
    task.controller = new AbortController();
    const abortTask = () =>
      task.controller?.abort(this.shutdownController.signal.reason);
    this.shutdownController.signal.addEventListener("abort", abortTask, {
      once: true,
    });
    const removeShutdownAbort = () =>
      this.shutdownController.signal.removeEventListener("abort", abortTask);
    try {
      if (!task.surfacePromise) {
        task.surfacePromise = this.persist({ strict: true }).then(() =>
          withTimeout(
            async (signal) => {
              if (this.closed || task.cancelled)
                throw new VoiceServiceError(
                  "TASK_CANCELLED",
                  "Task cancelled before surface recovery",
                  "開始前に中止しました。",
                );
              if (task.restoreSurface) {
                return this.#loadRestoredSurface(task);
              }
              if (this.closed || task.cancelled)
                throw new VoiceServiceError(
                  "TASK_CANCELLED",
                  "Task cancelled during surface recovery",
                  "開始前に中止しました。",
                );
              signal.throwIfAborted();
              return this.createTaskThread(task);
            },
            DEFAULT_STAGE_TIMEOUTS.posting,
            "recovering task thread",
            this.shutdownController.signal,
          ),
        );
      }
      taskSurface = await withTimeout(
        () => task.surfacePromise,
        DEFAULT_STAGE_TIMEOUTS.posting,
        "waiting for task thread",
        task.controller.signal,
      );
      task.surface = taskSurface;
      if (taskSurface?.threadId)
        this.tasksByThreadId.set(String(taskSurface.threadId), task);
      if (task.cancelled || this.closed) {
        if (task.cancelled) await this.#markCancelled(taskSurface, task);
        else await this.#markInterrupted(taskSurface, task);
        return;
      }
      task.executing = true;
      task.state = "running";
      await this.persist();
      postTaskText =
        typeof taskSurface === "function" ? taskSurface : taskSurface.post;
      const updateTask =
        typeof taskSurface === "function"
          ? async () => undefined
          : (state) => taskSurface.update(state);
      await this.#waitForInstructionReceipts(task);
      consumedInstruction = task.instructions.shift();
      task.additionalInstruction =
        typeof consumedInstruction === "string"
          ? consumedInstruction
          : consumedInstruction?.text;
      task.modelSelection =
        consumedInstruction?.modelSelection ?? task.modelSelection;
      task.activeSpecRevision =
        consumedInstruction?.specRevision ?? task.specRevision ?? 1;
      task.flushSteering = () => this.#flushSteering(task);
      task.additionalInstructionSource =
        typeof consumedInstruction === "object"
          ? structuredClone(consumedInstruction?.source)
          : undefined;
      await this.persist({ strict: true });
      const isContinuation = Boolean(task.additionalInstruction);
      await withTimeout(
        (signal) =>
          updateTask({
            state: "running",
            pendingInstructions: task.instructions.length,
            signal,
          }),
        DEFAULT_STAGE_TIMEOUTS.posting,
        "updating task status",
        task.controller.signal,
      );
      await withTimeout(
        (signal) =>
          postTaskText(this.presentation.taskStarted(task, isContinuation), {
            signal,
          }),
        DEFAULT_STAGE_TIMEOUTS.posting,
        "posting task start",
        task.controller.signal,
      );
      let progressPosts = 0;
      let lastProgress = "";
      let lastProgressAt = 0;
      const response = boundText(
        await withTimeout(
          (signal) => {
            const execution = Promise.resolve().then(() => {
              signal.throwIfAborted();
              workerInvoked = true;
              return this.runTask(task, {
                signal,
                onProgress: async (progress) => {
                  const content = boundText(
                    progress,
                    this.presentation.maximumText,
                  );
                  if (
                    !content ||
                    content === lastProgress ||
                    progressPosts >= 50 ||
                    Date.now() - lastProgressAt < this.progressIntervalMs
                  ) {
                    return;
                  }
                  lastProgress = content;
                  lastProgressAt = Date.now();
                  progressPosts += 1;
                  await withTimeout(
                    (postSignal) =>
                      postTaskText(content, { signal: postSignal }),
                    DEFAULT_STAGE_TIMEOUTS.posting,
                    "posting task progress",
                    signal,
                  ).catch((error) => {
                    if (signal.aborted) return;
                    this.#log("power_task_progress_post_failed", {
                      taskId: task.id,
                      errorCode: voiceErrorCode(error),
                    });
                  });
                },
              });
            });
            task.workerSettlement = execution.then(
              () => undefined,
              () => undefined,
            );
            return execution;
          },
          this.taskTimeoutMs,
          "running power task",
          task.controller.signal,
        ),
        MAX_RESPONSE_CHARACTERS,
      );
      task.result = response;
      await this.#waitForInstructionReceipts(task);
      let peerReview;
      if (
        this.reviewTask &&
        !task.remoteExecution &&
        task.assignedAgentTransport !== "remote" &&
        !isContinuation &&
        !(task.peerReviewCompletedRevisions ?? []).includes(task.runRevision)
      ) {
        try {
          const review = await withTimeout(
            (signal) => this.reviewTask(task, { signal }),
            this.taskTimeoutMs,
            "reviewing task with another Codex agent",
            task.controller.signal,
          );
          if (review) {
            peerReview = review;
            task.peerReviewCompletedRevisions ??= [];
            task.peerReviewCompletedRevisions.push(task.runRevision);
          }
          if (review?.feedback) {
            task.peerReviews ??= [];
            task.peerReviews.push({
              ...review,
              runRevision: task.runRevision,
              createdAt: Date.now(),
            });
            if (review.actionable && task.instructions.length < 10) {
              task.instructions.push({
                id: randomUUID(),
                text: review.feedback,
                requestKey: `peer-review:${task.id}:${task.runRevision}:${review.agentId}`,
                source: {
                  type: "agent_review",
                  agentId: review.agentId,
                  agentName: review.agentName,
                },
              });
            }
            await this.persist({ strict: true });
          }
        } catch (error) {
          this.#log("peer_review_failed", {
            taskId: task.id,
            errorCode: voiceErrorCode(error),
          });
        }
      }
      task.resultMetadata = {
        runRevision: task.runRevision,
        completedAt: Date.now(),
        verification: formatVerificationEvidence(task.evidence),
        specRevision: task.activeSpecRevision ?? 1,
        usage: structuredClone(task.usage),
      };
      workerSucceeded = true;
      task.additionalInstruction = undefined;
      task.additionalInstructionSource = undefined;
      await this.#waitForInstructionReceipts(task);
      const pendingInstructions = task.instructions.length;
      task.state = task.cancelled
        ? "cancelled"
        : pendingInstructions
          ? "queued"
          : "completed";
      task.resultDeliveries ??= [];
      task.resultDeliveries.push({
        runRevision: task.runRevision,
        specRevision: task.activeSpecRevision ?? 1,
        sourceSequences: [
          ...new Set([
            ...(task.sourceSequences ?? []),
            ...(consumedInstruction?.sourceSequences ?? []),
            ...(task.steeredInstructions ?? [])
              .filter((entry) => entry.runRevision === task.runRevision)
              .flatMap((entry) => entry.sourceSequences ?? []),
          ]),
        ],
        result: response,
        artifacts: structuredClone(task.artifacts),
        evidence: structuredClone(task.evidence),
        peerReview: structuredClone(peerReview),
        state: task.state,
        pendingInstructions,
        elapsedMs: Date.now() - task.createdAt,
        nextStep: 0,
      });
      task.resultDeliveryPending = true;
      await this.persist();
      void this.#deliverTaskResults(task);
      this.#log(
        pendingInstructions
          ? "power_task_continuation_queued"
          : "power_task_completed",
        {
          taskId: task.id,
          elapsedMs: Date.now() - startedAt,
          responseCharacters: response.length,
          progressPosts,
          pendingInstructions,
        },
      );
      await this.#waitForInstructionReceipts(task);
      if (task.instructions.length && !task.cancelled) {
        task.state = "queued";
        this.queue.push(task);
      } else if (!task.cancelled) task.state = "completed";
      await this.persist();
    } catch (error) {
      task.workerFailed = !workerSucceeded;
      if (this.closed && !task.cancelled) {
        if (!workerSucceeded)
          retainInterruptedInstruction(
            task,
            consumedInstruction,
            workerInvoked,
          );
        if (workerSucceeded && !task.instructions.length) {
          task.state = "completed";
          await this.persist();
        } else await this.#markInterrupted(taskSurface, task);
        return;
      }
      if (
        !workerSucceeded &&
        consumedInstruction &&
        !task.cancelled &&
        !this.closed &&
        error?.code !== "TASK_CANCELLED"
      ) {
        retainInterruptedInstruction(task, consumedInstruction, workerInvoked);
      }
      if (this.closed || task.cancelled || error?.code === "TASK_CANCELLED") {
        await this.#markCancelled(taskSurface, task);
      } else if (workerSucceeded) {
        task.state = task.instructions.length ? "queued" : "completed";
        task.resultDeliveryPending = true;
        await this.persist();
        if (task.instructions.length) this.queue.push(task);
        this.#log("task_result_delivery_failed", { taskId: task.id });
      } else {
        task.state = "failed";
        await this.persist();
        this.#log("power_task_failed", {
          taskId: task.id,
          elapsedMs: Date.now() - startedAt,
          errorCode: voiceErrorCode(error),
        });
        this.#queueTaskNotification(
          task,
          taskSurface,
          "failed",
          this.presentation.taskFailed(task, voiceErrorMessage(error)),
        );
      }
    } finally {
      await task.workerSettlement;
      removeShutdownAbort();
      task.executing = false;
      task.controller = undefined;
      task.additionalInstruction = undefined;
      task.workerSettlement = undefined;
      task.workerFailed = false;
      if (task.resumeAfterAbort && !this.closed && task.instructions.length) {
        task.resumeAfterAbort = false;
        task.cancelled = false;
        task.state = "queued";
        this.queue.push(task);
        await this.persist();
      }
    }
  }

  async #markCancelled(surface, task) {
    task.state = "cancelled";
    await this.persist();
    if (!surface) return;
    this.#queueTaskNotification(
      task,
      surface,
      "cancelled",
      this.presentation.taskCancelled(task),
    );
  }

  #queueTaskNotification(task, surface, state, content) {
    const version = task.controlVersion ?? 0;
    const revision = task.runRevision;
    const current = () =>
      task.state === state &&
      (task.controlVersion ?? 0) === version &&
      task.runRevision === revision;
    const post =
      typeof surface === "function"
        ? surface
        : (surface?.post ?? this.postText);
    const notification = withTimeout(
      async (signal) => {
        signal.throwIfAborted();
        if (!current()) return;
        try {
          await post(content, { signal });
        } catch (error) {
          if (!signal.aborted)
            this.#log("task_notification_post_failed", {
              taskId: task.id,
              errorCode: voiceErrorCode(error),
            });
        }
        signal.throwIfAborted();
        if (current())
          await surface?.update?.({
            state,
            elapsedMs: Date.now() - task.createdAt,
            signal,
            isCurrent: current,
          });
      },
      DEFAULT_STAGE_TIMEOUTS.posting,
      "posting task notification",
      this.shutdownController.signal,
    )
      .catch((error) => {
        if (!this.closed)
          this.#log("task_notification_failed", {
            taskId: task.id,
            errorCode: voiceErrorCode(error),
          });
      })
      .finally(() => this.notifications.delete(notification));
    this.notifications.add(notification);
  }

  async #markInterrupted(surface, task) {
    task.state = "interrupted";
    await this.persist();
    await withTimeout(
      () =>
        surface?.update?.({
          state: "interrupted",
          pendingInstructions: task.instructions.length,
        }),
      DEFAULT_STAGE_TIMEOUTS.posting,
      "showing interrupted task",
    ).catch(() => undefined);
  }

  #log(event, detail) {
    try {
      this.logger.info?.({
        component: "conversation-engine",
        event,
        ...detail,
      });
    } catch {
      // Task execution must not depend on logging.
    }
  }
}
