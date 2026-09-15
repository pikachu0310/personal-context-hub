import { id, text, type User } from "@ido/common/contracts/protocol";
import type { InputContext, PluginOutput } from "@ido/common/contracts/plugins";
import type { Device, Message } from "../../domain/models.js";
import type { Repository } from "../../ports/repository.js";
import type { InputRouter } from "../../processing/routing/input.js";
import { deviceIdentity } from "../../clients/identity.js";
import { Projects } from "../../processing/projects/service.js";
import { ProjectTeam } from "../../processing/projects/team.js";

type Entry = {
  id: number;
  at: number;
  kind: "transcript" | "reply" | "audio" | "notice" | "error";
  text?: string;
  audio?: string;
};
type Session = {
  entries: Entry[];
  requests: Set<string>;
  pending: number;
  nextId: number;
};

/** Browser input uses the same meeting router as installed transports. */
export class ClientMeetingInput {
  private sessions = new Map<string, Session>();
  constructor(
    readonly store: Repository,
    readonly router: InputRouter,
    readonly changed: () => void,
  ) {}

  private session(deviceId: string, projectId: string) {
    const key = `${deviceId}:${projectId}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = { entries: [], requests: new Set(), pending: 0, nextId: 1 };
      this.sessions.set(key, session);
    }
    return session;
  }

  async request(
    device: Device,
    operation: string,
    input: Record<string, unknown>,
    connected: () => boolean,
  ) {
    const projectId = id(input.projectId);
    const team = new ProjectTeam(this.store);
    team.require(device.id, projectId);
    const session = this.session(device.id, projectId);
    const valid = () => {
      try {
        team.require(device.id, projectId);
        const owner = this.store.user(device.userId);
        return (
          connected() &&
          this.store.get<Device>("device", device.id)?.generation ===
            device.generation &&
          !!owner &&
          owner.role !== "viewer"
        );
      } catch {
        return false;
      }
    };
    const view = () => ({
      entries: session.entries
        .filter(
          (entry) =>
            entry.kind !== "audio" ||
            (input.audioReplies === true && entry.audio),
        )
        .map(({ audio, ...entry }) =>
          input.audioReplies === true ? { ...entry, audio } : entry,
        ),
      pending: session.pending,
    });
    if (operation === "project.meeting.read") return view();
    if (!valid()) throw new Error("PERMISSION_DENIED");
    const requestId = id(input.requestId);
    if (session.requests.has(requestId)) return { accepted: true, ...view() };
    if (session.pending >= 2) throw new Error("MEETING_INPUT_BUSY");
    const content =
      input.text === undefined ? undefined : text(input.text, 16000).trim();
    const audio = input.audio;
    if (
      audio !== undefined &&
      (typeof audio !== "string" ||
        audio.length > 550000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(audio))
    )
      throw new Error("INVALID_MEETING_AUDIO");
    if ((!content && !audio) || (!!content && !!audio))
      throw new Error("MEETING_INPUT_REQUIRED");
    const actor: User = {
      id: `browser:${deviceIdentity(this.store, device) ?? device.id}`,
      name: device.profile?.name ?? device.name,
      role: "member",
    };
    this.store.put("participant", actor.id, actor);
    const add = (kind: Entry["kind"], value: Pick<Entry, "text" | "audio">) => {
      const entry = { id: session.nextId++, at: Date.now(), kind, ...value };
      session.entries.push(entry);
      session.entries = session.entries.slice(-30);
      const withAudio = session.entries.filter((item) => item.audio);
      for (const old of withAudio.slice(0, -2)) delete old.audio;
      return entry;
    };
    const received = add(audio ? "notice" : "transcript", {
      text: content ?? "音声を文字起こししています…",
    });
    const eventId = `${device.id}:${requestId}`;
    const event = new Projects(this.store).accept(
      {
        eventId,
        projectId,
        subject: device.id,
        text: content,
        audio: audio as string | undefined,
      },
      "browser",
    );
    const context: InputContext = {
      pluginId: "browser",
      actor,
      valid,
      deliver: async (output: PluginOutput) => {
        if (!valid()) return;
        if (output.kind === "reply" && output.content)
          add("reply", { text: output.content.slice(0, 16000) });
        if (
          output.kind === "audio" &&
          output.audio &&
          output.audio.length <= 700000 &&
          output.audioFormat !== "pcm16-24000-mono"
        )
          add("audio", { audio: output.audio });
      },
      publish: () => {
        if (valid()) this.changed();
      },
    };
    session.requests.add(requestId);
    if (session.requests.size > 200)
      session.requests.delete(session.requests.values().next().value!);
    session.pending++;
    void this.router
      .handle(event, context)
      .then(() => {
        if (!valid()) return;
        const record = this.store.get<{ messageId?: string; stage?: string }>(
          "input",
          `browser:${eventId}`,
        );
        const message = record?.messageId
          ? this.store.get<Message>("message", record.messageId)
          : undefined;
        if (audio) {
          received.kind = message?.text
            ? "transcript"
            : record?.stage === "failed"
              ? "error"
              : "notice";
          received.text =
            message?.text ||
            (record?.stage === "ignored"
              ? "音声から発言を読み取れませんでした。もう一度お話しください。"
              : record?.stage === "failed"
                ? "音声の処理に失敗しました。文章で送るか、録音し直してください。"
                : "音声を受け付けました。議事録へ反映します。");
        }
        this.changed();
      })
      .catch(() => {
        if (valid())
          add("error", {
            text: "会議への入力を処理できませんでした。接続やEngineの設定を確認してください。",
          });
      })
      .finally(() => {
        session.pending--;
      });
    return { accepted: true, meetingId: event.meetingId, ...view() };
  }
}
