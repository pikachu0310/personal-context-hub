import type { InputContext } from "@ido/common/contracts/plugins";
import type { Meeting } from "../../domain/models.js";
export function publishMeeting(
  context: InputContext,
  type: "transcript" | "minutes",
  meeting: Meeting,
) {
  if (context.valid())
    context.publish({ type, meetingId: meeting.id, data: meeting });
}
