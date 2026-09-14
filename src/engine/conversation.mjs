import { createTelemetry } from "./telemetry.mjs";
import { TurnSession } from "./turn-session.mjs";
import { MeetingSession } from "./meeting-session.mjs";
import { TaskQueue } from "./task-queue.mjs";
import { plainPresentation } from "./output/presentation.mjs";
import { createInputPort } from "./input/port.mjs";
import { normalizeOutput } from "./output/port.mjs";
import { createWorkPort } from "./work-port.mjs";

// Composition independent of devices, SDKs, credentials and filesystem paths.
// The caller prepares execution and owns store acquisition/release and transport lifecycle.
export async function createConversationEngine({
  config,
  onEvent,
  audio = {},
  execution = {},
  coordinator: coordinatorPort,
  workPort: suppliedWorkPort,
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
    taskQueue =
      config.powerMode && !suppliedWorkPort
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
              session?.conversationModes?.onTaskState(tasks);
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
    const workPort = suppliedWorkPort ?? createWorkPort(taskQueue);
    session =
      config.voiceMode === "meeting"
        ? new MeetingSession({
            telemetry,
            presentation,
            speechEnabled: output.capabilities.audio,
            transcribe: audio.transcribe?.bind(audio),
            createCoordinator:
              coordinatorPort?.createCoordinator?.bind(coordinatorPort),
            conversationModes: dependencies.conversationModes,
            classifyInput: dependencies.classifyInput,
            createSpeechOutput: dependencies.createSpeechOutput,
            quickReply: audio.quickReply?.bind(audio),
            classifyVoiceNeed: audio.classifyVoiceNeed?.bind(audio),
            revalidateReply: audio.revalidateReply?.bind(audio),
            investigateQuestion: execution.investigateQuestion,
            getRuntimeContext: hooks.getRuntimeContext,
            onStatement: hooks.onStatement,
            onMeetingReset: hooks.onMeetingReset,
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
            enqueueTask: (task) =>
              task.executionPolicy?.sandboxMode === "read-only" &&
              task.kind === "research"
                ? workPort.submitResearch(task)
                : workPort.submit(task),
            controlTask: (control) => workPort.control(control),
            getTaskReceipt: (requestKey) => workPort.getReceipt(requestKey),
            getTaskResult: (taskId) => workPort.getResult(taskId),
            ownerUserId: config.allowedUserId,
            tasksEnabled: config.powerMode,
            operatorUserIds: config.operatorUserIds,
            allParticipantsOperate: config.allParticipantsOperate,
            autonomousTasks: config.autonomousTasks,
            answerUnaddressedQuestions: config.answerUnaddressedQuestions,
            requireWakeWord: config.requireWakeWord,
            initialState: saved?.meeting,
            checkpoint: (meeting) => store?.save({ meeting }),
            getTasks: () => workPort.list(),
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

    return {
      session,
      taskQueue,
      workPort,
      telemetry,
      input: createInputPort(session),
      acceptWorkResult: async (result, options) => {
        await session.addTaskResult?.(result, options);
        hooks.onTaskResult?.(result);
      },
      acceptWorkState: (tasks) => session.conversationModes?.onTaskState(tasks),
    };
  } catch (error) {
    await Promise.allSettled([session?.stop(), taskQueue?.stop()]);
    throw error;
  }
}
