import type { PluginEvent } from "@ido/common/contracts/plugins";
import type { Rpc } from "@ido/common/runtime/rpc";
import type { DiscordState } from "../runtime/state.js";
import { Publications } from "./publications.js";
import { renderPublication } from "./render.js";

/** One current transcript per channel; older project deliveries cannot replace it. */
export class ConversationPublications {
  constructor(
    readonly state: Pick<DiscordState, "config" | "speechEpoch" | "client">,
    readonly rpc: () => Pick<Rpc, "request">,
    readonly publications: Publications,
  ) {}
  async publish(event: PluginEvent) {
    const epoch = this.state.speechEpoch;
    const channelId = this.state.config.textChannelId;
    const projectId = this.state.config.projectId;
    const key =
      event.type === "transcript"
        ? `transcript-current-${channelId}`
        : `${event.type}-${event.meetingId}-${channelId}`;
    const isCurrent = () =>
      epoch === this.state.speechEpoch &&
      channelId === this.state.config.textChannelId &&
      projectId === this.state.config.projectId &&
      (event.data as { projectId?: string }).projectId === projectId;
    const saved = await this.rpc().request<{ messageId?: string } | undefined>(
      "storage.get",
      { key },
    );
    if (!isCurrent()) return;
    await this.publications.update(
      key,
      channelId,
      renderPublication(event),
      saved?.messageId,
      isCurrent,
    );
  }
  async refresh() {
    if (!this.state.client?.isReady()) return;
    const epoch = this.state.speechEpoch;
    const snapshot = await this.rpc().request<{
      project: import("@ido/common/contracts/protocol").Project;
      meeting: import("@ido/common/contracts/api").MeetingView;
    }>("projects.current", {});
    if (
      epoch !== this.state.speechEpoch ||
      snapshot.project.id !== this.state.config.projectId
    )
      return;
    await this.publish({
      type: "transcript",
      meetingId: snapshot.meeting.id,
      data: { ...snapshot.meeting, projectName: snapshot.project.name },
    });
  }
}
