import { createTelemetry } from "./telemetry.mjs";
import { TurnSession } from "./turn-session.mjs";
import { MeetingSession } from "./meeting-session.mjs";
import { TaskQueue } from "./task-queue.mjs";
import { plainPresentation } from "./output/presentation.mjs";
import { createInputPort } from "./input/port.mjs";
import { normalizeOutput } from "./output/port.mjs";

// Composition independent of devices, SDKs, credentials and filesystem paths.
// The caller prepares execution and owns store acquisition/release and transport lifecycle.
export async function createConversationEngine({
  config,
  onEvent,
  audio = {},
  execution,
  output: suppliedOutput,
  store,
  initialState: saved,
  transcriptArchive,
  logger = console,
  dependencies = {},
  hooks = {},
}) {
  const telemetry = createTelemetry(onEvent);
  const originalExecution = execution;
  execution = {
    ...execution,
    run: telemetry.wrap("EXECUTE", execution.run?.bind(execution)),
    observeMeeting: telemetry.wrap(
      "OBSERVE",
      execution.observeMeeting?.bind(execution),
      (observation) => ({
        inputIds:
          observation.statements?.map(
            (s) => `${observation.meetingId}:I-${s.sequence}`,
          ) ?? [],
      }),
    ),
    investigateQuestion: telemetry.wrap(
      "IMMEDIATE",
      execution.investigateQuestion?.bind(execution),
    ),
    runTask: (task, options) =>
      telemetry.scope(
        {
          taskId: task.id,
          runId: String((task.runRevision ?? 0) + 1),
          inputIds: (task.sourceSequences ?? []).map(
            (n) => `${task.meetingId}:I-${n}`,
          ),
        },
        () =>
          telemetry.wrap(
            "EXECUTE",
            originalExecution.runTask.bind(originalExecution),
          )(task, {
            ...options,
            onEvent: (event) =>
              telemetry.emit({
                ...event,
                stage: "EXECUTE",
                spanId: `tool-${task.id}-${task.runRevision ?? 0}-${event.itemId}`,
              }),
          }),
      ),
  };
  audio = {
    ...audio,
    transcribe: telemetry.wrap("STT", audio.transcribe?.bind(audio)),
    quickReply: telemetry.wrap("IMMEDIATE", audio.quickReply?.bind(audio)),
    synthesize: telemetry.wrap("TTS", audio.synthesize?.bind(audio)),
  };
  const output = normalizeOutput(suppliedOutput);
  output.postText = telemetry.wrap("DELIVER", output.postText, (text) => ({
    text,
  }));
  output.playAudio = telemetry.wrap("PLAYBACK", output.playAudio);
  if (output.speak) {
    const speak = output.speak;
    output.speak = (...args) => {
      telemetry.emit({
        stage: "PLAYBACK",
        spanId: "live-request-" + Date.now(),
        status: "skipped",
        reason: "live_playback_unprovided",
      });
      return speak(...args);
    };
  }

  const {
    postText,
    createTaskThread: rawCreateTaskThread,
    upsertLiveTranscript,
    upsertMinutes,
    playAudio,
  } = output;
  const instrumentSurface = (surface, task) => {
    if (typeof surface?.post !== "function") return surface;
    const instrumented = Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors(surface),
    );
    instrumented.post = (...args) =>
      telemetry.scope(
        {
          taskId: task.id,
          runId: String(task.runRevision ?? 0),
          inputIds: (task.sourceSequences ?? []).map(
            (sequence) => `${task.meetingId}:I-${sequence}`,
          ),
        },
        () =>
          telemetry.wrap("DELIVER", surface.post.bind(surface), (text) => ({
            text,
          }))(...args),
      );
    return instrumented;
  };
  const createTaskThread = async (task) =>
    instrumentSurface(await rawCreateTaskThread(task), task);
  const presentation = output.presentation ?? plainPresentation;
  let taskQueue, session;
  try {
    taskQueue = config.powerMode
      ? new TaskQueue({
          presentation,
          agentTeam: dependencies.agentTeam,
          reviewTask: execution.reviewTask,
          runTask: (task, options) => execution.runTask(task, options),
          steerTask: execution.steerTask,
          confirmPreview: execution.confirmPreview,
          restartPreview: execution.restartPreview,
          invalidatePreview: execution.invalidatePreview,
          postText,
          createTaskThread,
          logger,
          concurrency: config.taskConcurrency,
          maximumPendingTasks: config.maximumPendingTasks,
          taskTimeoutMs: config.stageTimeouts?.running_codex,
          checkpoint: async (tasks) => {
            for (const task of tasks) telemetry.taskState(task);
            await store?.save({ tasks });
            hooks.onTaskState?.(tasks);
          },
          onResult: async (result, options) => {
            await session?.addTaskResult?.(result, {
              ...options,
              resultAlreadyDelivered:
                output.capabilities.threadedResults === true,
            });
            hooks.onTaskResult?.(result);
          },
          applyTask: (task) => execution.applyTask(task),
        })
      : undefined;
    if (taskQueue && saved?.tasks?.length) {
      await taskQueue.restore(saved.tasks, async (task) =>
        instrumentSurface(await output.restoreTaskSurface(task), task),
      );
    }
    session =
      config.voiceMode === "meeting"
        ? new MeetingSession({
            telemetry,
            presentation,
            speechEnabled: output.capabilities.audio,
            transcribe: audio.transcribe?.bind(audio),
            quickReply: audio.quickReply?.bind(audio),
            classifyVoiceNeed: audio.classifyVoiceNeed?.bind(audio),
            revalidateReply: audio.revalidateReply?.bind(audio),
            investigateQuestion: execution.investigateQuestion,
            getRuntimeContext: hooks.getRuntimeContext,
            onStatement: hooks.onStatement,
            speak: output.speak,
            isLive: output.isLive,
            stopSpeech: output.stopSpeech,
            observe: (observation, options) =>
              execution.observeMeeting(observation, options),
            upsertLiveTranscript,
            upsertMinutes,
            archiveTranscript: (statement) =>
              transcriptArchive?.append(statement),
            closeTranscriptArchive: () => transcriptArchive?.stop(),
            postText,
            synthesize: audio.synthesize?.bind(audio),
            playAudio,
            enqueueTask: (task) => taskQueue?.enqueueDurable(task) ?? false,
            controlTask: (control) =>
              taskQueue?.handleVoiceControlDurable(control) ?? false,
            getTaskReceipt: (requestKey) => taskQueue?.getReceipt(requestKey),
            getTaskResult: (taskId) => taskQueue?.getTaskResult(taskId),
            ownerUserId: config.allowedUserId,
            tasksEnabled: config.powerMode,
            operatorUserIds: config.operatorUserIds,
            allParticipantsOperate: config.allParticipantsOperate,
            autonomousTasks: config.autonomousTasks,
            answerUnaddressedQuestions: config.answerUnaddressedQuestions,
            requireWakeWord: config.requireWakeWord,
            initialState: saved?.meeting,
            checkpoint: (meeting) => store?.save({ meeting }),
            getTasks: () => taskQueue?.list() ?? [],
            logger,
            observationIntervalMs: config.observationIntervalMs,
            immediateReactions: config.immediateReactions,
            transcriptionConcurrency: config.transcriptionConcurrency,
            maximumPendingTranscriptions: config.maximumPendingTranscriptions,
            stageTimeouts: config.stageTimeouts,
            scheduleInterval: dependencies.scheduleInterval,
            cancelInterval: dependencies.cancelInterval,
          })
        : new TurnSession({
            telemetry,
            presentation,
            speechEnabled: output.capabilities.audio,
            transcribe: audio.transcribe?.bind(audio),
            run: (transcript, options) => execution.run(transcript, options),
            synthesize: audio.synthesize?.bind(audio),
            postText,
            playAudio,
            logger,
            maximumQueuedTurns: config.maximumQueuedTurns,
            stageTimeouts: config.stageTimeouts,
          });

    return { session, taskQueue, telemetry, input: createInputPort(session) };
  } catch (error) {
    await Promise.allSettled([session?.stop(), taskQueue?.stop()]);
    throw error;
  }
}
