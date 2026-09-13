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
  const output = normalizeOutput(suppliedOutput);
  const {
    postText,
    createTaskThread,
    upsertLiveTranscript,
    upsertMinutes,
    playAudio,
  } = output;
  const presentation = output.presentation ?? plainPresentation;
  let taskQueue, session;
  try {
    taskQueue = config.powerMode
      ? new TaskQueue({
          presentation,
          runTask: (task, options) => execution.runTask(task, options),
          steerTask: execution.steerTask,
          confirmPreview: execution.confirmPreview,
          invalidatePreview: execution.invalidatePreview,
          postText,
          createTaskThread,
          logger,
          concurrency: config.taskConcurrency,
          maximumPendingTasks: config.maximumPendingTasks,
          taskTimeoutMs: config.stageTimeouts?.running_codex,
          checkpoint: async (tasks) => {
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
      await taskQueue.restore(saved.tasks, output.restoreTaskSurface);
    }
    session =
      config.voiceMode === "meeting"
        ? new MeetingSession({
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

    return { session, taskQueue, input: createInputPort(session) };
  } catch (error) {
    await Promise.allSettled([session?.stop(), taskQueue?.stop()]);
    throw error;
  }
}
