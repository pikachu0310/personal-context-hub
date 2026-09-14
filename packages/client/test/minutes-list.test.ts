import assert from "node:assert/strict";
import test from "node:test";
import type { MeetingView } from "@ido/common/contracts/api";
import { visibleMinutes } from "../src/ui/minutes-list.js";

test("minutes exclude empty documents without discarding their source transcripts", () => {
  const meetings: MeetingView[] = [
    { id: "old", name: "Old", summary: "Saved", startedAt: 10, messages: [] },
    { id: "empty", name: "Empty", summary: "", startedAt: 40, messages: [] },
    {
      id: "pending",
      name: "Pending",
      summary: " \n\t　",
      startedAt: 30,
      messages: [
        {
          id: "source",
          authorId: "author",
          text: "Recorded speech",
          at: 30,
          stage: "completed",
        },
      ],
    },
    {
      id: "new",
      name: "New",
      summary: "# Latest",
      startedAt: 20,
      messages: [],
    },
    { id: "legacy", name: "Undated", summary: "Manual notes", messages: [] },
  ];
  const before = structuredClone(meetings);
  assert.deepEqual(
    visibleMinutes(meetings).map((m) => m.id),
    ["new", "old", "legacy"],
  );
  assert.deepEqual(meetings, before);
  meetings[2].summary = "Generated notes";
  assert.equal(visibleMinutes(meetings)[0].id, "pending");
  meetings[2].summary = "";
  assert.equal(visibleMinutes(meetings).length, 3);
});
