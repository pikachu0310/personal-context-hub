// Conversation modes own response delivery. They do not own transcript capture,
// task execution, or the coordinator's durable input queue. Provider objects stay
// in the runtime; these callbacks also allow other speech implementations.
export function createTextSpeechConversationMode({
  enqueueSpeech,
  stopSpeech = () => {},
}) {
  if (typeof enqueueSpeech !== "function")
    throw new TypeError("text-speech enqueueSpeech is required");
  return Object.freeze({
    kind: "text-speech",
    suppressesLocalQuickReply: false,
    observationContext: Object.freeze({
      voiceOwner: "coordinator",
      answerPolicy: "coordinator_answers",
    }),
    canDeliverReply: () => true,
    acceptCoordinatorReply: () => true,
    deliverReply: (reply, context) => enqueueSpeech(reply, context),
    stopSpeech,
  });
}

export function createLiveConversationMode({
  sendReply,
  observeStatement = () => {},
  onTaskState = () => {},
  stopSpeech = () => {},
  isReady = () => true,
}) {
  if (typeof sendReply !== "function")
    throw new TypeError("live sendReply is required");
  return Object.freeze({
    kind: "live",
    suppressesLocalQuickReply: true,
    observationContext: Object.freeze({
      voiceOwner: "live",
      answerPolicy: "backend_facts_only",
    }),
    canDeliverReply: isReady,
    acceptCoordinatorReply: ({ events = [], observation }) =>
      events.some(
        (event) =>
          event.type === "task_result" ||
          (event.type === "statement" &&
            event.statement.origin === "text" &&
            observation.replySourceSequences?.includes(
              event.statement.sequence,
            )),
      ) ||
      ["verified_correction", "new_finding"].includes(observation.replyReason),
    deliverReply: (reply, context) => sendReply(reply, context),
    observeStatement,
    onTaskState,
    stopSpeech,
  });
}

function validateMode(mode) {
  if (
    !mode?.kind ||
    typeof mode.deliverReply !== "function" ||
    typeof mode.stopSpeech !== "function" ||
    typeof mode.canDeliverReply !== "function"
  )
    throw new TypeError("conversation mode must implement delivery and stop");
  return mode;
}

export function createConversationModeController({
  textSpeech,
  initialMode = textSpeech,
}) {
  let active = validateMode(initialMode);
  let transition = Promise.resolve();
  let revision = 0;
  return {
    get kind() {
      return active.kind;
    },
    get revision() {
      return revision;
    },
    get observationContext() {
      return active.observationContext;
    },
    get suppressesLocalQuickReply() {
      return active.suppressesLocalQuickReply === true;
    },
    canDeliverReply() {
      return active.canDeliverReply();
    },
    acceptCoordinatorReply(details) {
      return active.acceptCoordinatorReply?.(details) ?? true;
    },
    select(mode = textSpeech) {
      validateMode(mode);
      const selecting = transition.then(async () => {
        if (mode === active) return active.kind;
        // Wait for the old queue/player to stop before allowing new replies.
        // A failed stop leaves the original mode selected.
        await active.stopSpeech();
        active = mode;
        revision++;
        return active.kind;
      });
      transition = selecting.catch(() => {});
      return selecting;
    },
    async routeReply(reply, context = {}) {
      await transition;
      if (
        context.modeRevision !== undefined &&
        context.modeRevision !== revision
      )
        return { status: "discarded", reason: "conversation_mode_changed" };
      if (!active.canDeliverReply())
        return { status: "unavailable", reason: "conversation_mode_not_ready" };
      return active.deliverReply(reply, context);
    },
    observeStatement(statement) {
      return active.observeStatement?.(statement);
    },
    onTaskState(tasks) {
      return active.onTaskState?.(tasks);
    },
    stopSpeech() {
      return active.stopSpeech();
    },
  };
}
