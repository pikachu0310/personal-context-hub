export interface ProjectDraft {
  text: string;
  requestId: string;
  sentText?: string;
  busy?: boolean;
}
export interface DraftState {
  drafts: Record<string, ProjectDraft>;
  remembered: Record<string, string>;
}
export const emptyDraftState: DraftState = { drafts: {}, remembered: {} };
export type DraftAction =
  | { type: "open"; projectId: string; requestId: string }
  | { type: "leave"; active?: string }
  | { type: "edit"; projectId: string; text: string }
  | { type: "sending"; projectId: string; requestId: string; text: string }
  | { type: "settled" | "complete"; projectId: string; requestId: string };

export function projectDrafts(
  state: DraftState,
  action: DraftAction,
): DraftState {
  if (action.type === "leave") {
    const abandoned = Object.entries(state.drafts).filter(
      ([id, draft]) => id !== action.active && draft.sentText === undefined,
    );
    if (!abandoned.length) return state;
    const drafts = { ...state.drafts },
      remembered = { ...state.remembered };
    for (const [id, draft] of abandoned) {
      if (draft.text.trim()) remembered[id] = draft.text;
      else delete remembered[id];
      delete drafts[id];
    }
    return { drafts, remembered };
  }
  const current = state.drafts[action.projectId];
  if (action.type === "open") {
    if (current) return state;
    return {
      ...state,
      drafts: {
        ...state.drafts,
        [action.projectId]: {
          text: state.remembered[action.projectId] ?? "",
          requestId: action.requestId,
        },
      },
    };
  }
  if (
    !current ||
    ("requestId" in action && action.requestId !== current.requestId)
  )
    return state;
  if (action.type === "complete") {
    const drafts = { ...state.drafts },
      remembered = { ...state.remembered };
    delete drafts[action.projectId];
    delete remembered[action.projectId];
    return { drafts, remembered };
  }
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [action.projectId]: {
        ...current,
        ...(action.type === "edit"
          ? { text: action.text }
          : action.type === "sending"
            ? { sentText: action.text, busy: true }
            : { busy: false }),
      },
    },
  };
}
