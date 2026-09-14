// Offline, idempotent import from the archived Discord Voice runtime.
// Credentials and Codex session files are deliberately outside this importer.
import { readFile, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../packages/engine/src/adapters/sqlite/store.ts";
import { atomic, json } from "../packages/common/src/runtime/platform.ts";
import { seedParticipants } from "../packages/engine/src/processing/projects/task-participants.ts";
import {
  forumContent,
  forumKey,
} from "../packages/plugin-discord/src/forum/sync.ts";

const fingerprint = (message) =>
  createHash("sha256")
    .update(JSON.stringify([message.authorId, message.text]))
    .digest("hex");
const at = (value, fallback = Date.now()) => {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function importMeeting({
  store,
  savedRuns,
  snapshot,
  records,
  projectId,
  deviceId,
  binding,
}) {
  if (!store.get("project", projectId) || !store.get("device", deviceId))
    throw new Error("IMPORT_TARGET_REQUIRED");
  const terminal = new Set(["completed", "cancelled", "interrupted", "failed"]);
  if ((snapshot.tasks ?? []).some((task) => !terminal.has(task.state)))
    throw new Error("LEGACY_TASKS_ACTIVE");
  const author = (userId, name) => {
    const subject = String(userId || "unknown");
    const key = `discord:${subject}`;
    const linked = store.get("external-identity", key);
    if (linked) return linked.userId;
    let actorId = store.get("external-participant", key)?.actorId;
    if (!actorId) {
      actorId = `legacy-discord-${subject}`;
      store.put("external-participant", key, { actorId });
    }
    const existing = store.get("participant", actorId);
    store.put("participant", actorId, {
      ...existing,
      id: actorId,
      name: String(name || existing?.name || `Discord ${subject}`).slice(
        0,
        100,
      ),
      role: existing?.role ?? "member",
    });
    return actorId;
  };
  const meetingId = snapshot.meeting.meetingId;
  const scope = records.filter(
    (record) =>
      record.meetingId === meetingId &&
      record.guildId === binding.guildId &&
      record.voiceChannelId === binding.voiceChannelId &&
      record.textChannelId === binding.issueForumChannelId,
  );
  const sources = new Map();
  const imported = {
    messages: 0,
    tasks: 0,
    retainedRuns: 0,
    threadBindings: 0,
  };
  const current = store.get("meeting", meetingId);
  if (current && current.projectId !== projectId)
    throw new Error("IMPORT_MEETING_CONFLICT");
  store.transaction(() => {
    if (!current)
      store.put("meeting", meetingId, {
        id: meetingId,
        projectId,
        name: "移行前の会議",
        startedAt: Math.min(...scope.map((record) => at(record.startedAt))),
        closedAt: at(snapshot.updatedAt),
        summary: snapshot.meeting.minutes ?? "",
        summaryRevision: 1,
        summaryUpdatedAt: at(snapshot.updatedAt),
        summaryState: "ready",
        messages: [],
      });
    for (const record of scope) {
      if (typeof record.text !== "string" || !record.text.trim()) continue;
      const message = {
        id: record.id,
        meetingId,
        authorId: author(record.userId, record.speakerName),
        authorName: record.speakerName,
        role: "user",
        origin: "audio",
        text: record.text,
        at: at(record.startedAt, at(record.recordedAt)),
        stage: "completed",
        complete: true,
        capture: {
          sessionId: `legacy-${meetingId}`,
          utteranceId: record.utteranceId ?? record.id,
          segmentIndex: record.segmentIndex ?? 0,
          startedAt: at(record.startedAt),
          endedAt: at(record.recordedAt),
          final: true,
        },
      };
      const previous = store.get("message", message.id);
      if (
        previous &&
        (previous.meetingId !== meetingId || previous.text !== message.text)
      )
        throw new Error("IMPORT_MESSAGE_CONFLICT");
      if (!previous) {
        store.put("message", message.id, message);
        imported.messages++;
      }
      sources.set(record.sequence, [
        ...(sources.get(record.sequence) ?? []),
        message,
      ]);
    }
    const progress = store.get("minutes-progress", meetingId) ?? {
      meetingId,
      sources: {},
      taskLinks: [],
    };
    for (const messages of sources.values())
      for (const message of messages)
        progress.sources[message.id] = fingerprint(message);
    store.put("minutes-progress", meetingId, progress);
    const key = forumKey(binding);
    const threadRecords = store.get("plugin:discord", key) ?? [];
    for (const legacy of snapshot.tasks ?? []) {
      const requestId = `legacy-voice:${legacy.id}`;
      let task = store.get("task", legacy.id);
      if (task && task.requestId !== requestId)
        throw new Error("IMPORT_TASK_CONFLICT");
      if (!task) {
        const original = legacy.sourceStatements ?? [];
        const requested =
          typeof legacy.request === "string" ? legacy.request : legacy.title;
        const statements = original.map((statement) => ({
          ...statement,
          authorId: author(
            statement.userId ?? statement.authorId,
            statement.speakerName,
          ),
        }));
        const authorId =
          statements[0]?.authorId ?? author(undefined, "移行前の参加者");
        const revision = Math.max(1, Number(legacy.runRevision) || 1);
        task = {
          id: legacy.id,
          requestId,
          projectId,
          meetingId,
          authorId,
          title: legacy.title,
          text: requested || legacy.id,
          state: legacy.state,
          runId: `legacy-${legacy.id}`,
          revision,
          clientId: deviceId,
          network: true,
          createdByBot: true,
          createdAt: at(legacy.createdAt),
          updatedAt: at(snapshot.updatedAt),
          kind: legacy.kind,
          result: legacy.result,
          sourceSequences: legacy.sourceSequences ?? [],
          sourceStatements: statements,
          sourceIds: (legacy.sourceSequences ?? []).flatMap((sequence) =>
            (sources.get(sequence) ?? []).map((message) => message.id),
          ),
          specRevision: legacy.specRevision ?? 1,
          resultSpecRevision: legacy.specRevision ?? 1,
          controlVersion: 0,
          controlReceipts: {},
          history: [],
        };
        seedParticipants(store, task);
        store.put("task", task.id, task);
        store.rememberRequest(
          JSON.stringify([authorId, projectId, requestId]),
          task.id,
        );
        imported.tasks++;
      }
      if (!savedRuns.runs[task.runId] && legacy.workingDirectory) {
        savedRuns.runs[task.runId] = {
          task,
          directory: legacy.workingDirectory,
          threadId: legacy.codexThreadId ?? legacy.execution?.threadId,
          state: task.state,
          result: legacy.result,
          agent: "codex",
          progressMode: "auto",
          meetingToolsEnabled: false,
          boardToolsEnabled: false,
          activeSpecRevision: task.specRevision,
          updatedAt: task.updatedAt,
          activity: [
            {
              id: `migration-${task.id}`,
              at: Date.now(),
              kind: "status",
              title: "移行前の作業を引き継ぎ",
              text: "成果物とCodex履歴を保持しています。追加指示は同じ作業場所で続けます。",
            },
          ],
          instructions: [],
          controlReceipts: {},
        };
        imported.retainedRuns++;
      }
      if (!threadRecords.some((record) => record.taskId === task.id)) {
        const marker = `IDO task ${task.id}`;
        threadRecords.push(
          legacy.threadId
            ? {
                taskId: task.id,
                marker,
                threadId: legacy.threadId,
                content: forumContent(
                  task,
                  marker,
                  binding.messageContentIntent,
                ),
              }
            : {
                taskId: task.id,
                marker,
                suppressedUntilRevision: task.revision,
              },
        );
        imported.threadBindings++;
      }
    }
    store.put("plugin:discord", key, threadRecords);
    store.put("legacy-migration", meetingId, {
      meetingId,
      projectId,
      updatedAt: Date.now(),
      sourceUpdatedAt: snapshot.updatedAt,
      messages: scope.length,
      tasks: snapshot.tasks?.length ?? 0,
    });
  });
  return imported;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const option = (name) => process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes("--apply"))
    throw new Error("OFFLINE_IMPORT_REQUIRES_APPLY");
  for (const name of [
    "--state",
    "--transcripts",
    "--engine-dir",
    "--client-dir",
    "--project",
  ])
    if (!process.argv.includes(name)) throw new Error(`MISSING_OPTION:${name}`);
  const snapshot = JSON.parse(await readFile(option("--state"), "utf8"));
  const clientDirectory = await realpath(option("--client-dir"));
  const settings = JSON.parse(
    await readFile(join(clientDirectory, "client.json"), "utf8"),
  );
  const [guildId, voiceChannelId, textChannelId] = snapshot.scope.split(":");
  const directory = join(option("--transcripts"), guildId);
  const records = [];
  for (const file of (await readdir(directory))
    .filter((file) => file.endsWith(".jsonl"))
    .sort()) {
    for (const line of (await readFile(join(directory, file), "utf8"))
      .split("\n")
      .filter(Boolean))
      records.push(JSON.parse(line));
  }
  const store = new Store(option("--engine-dir"));
  try {
    const savedRuns = await json(join(clientDirectory, "runs.json"), {
      runs: {},
      commands: [],
    });
    const report = importMeeting({
      store,
      savedRuns,
      snapshot,
      records,
      projectId: option("--project"),
      deviceId: settings.deviceId,
      binding: {
        guildId,
        voiceChannelId,
        issueForumChannelId: textChannelId,
        projectId: option("--project"),
        messageContentIntent: "false",
      },
    });
    await atomic(join(clientDirectory, "runs.json"), savedRuns);
    console.log(JSON.stringify(report));
  } finally {
    store.close();
  }
}
