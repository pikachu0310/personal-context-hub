export type Observation = {
  sequence: number;
  sessionId: string;
  at: number;
  startedAt?: number;
  stage: string;
  status: string;
  spanId?: string;
  inputIds: string[];
  taskId?: string;
  runId?: string;
  parentId?: string;
  text?: string;
  speaker?: string;
  title?: string;
  tool?: string;
  query?: string;
  summary?: string;
  reason?: string;
};
export type Snapshot = {
  sessionId: string;
  sequence: number;
  events: Observation[];
  active?: Observation[];
};
export function append(state: Snapshot, event: Observation): Snapshot | null {
  if (event.sessionId !== state.sessionId) return null;
  if (event.sequence <= state.sequence) return state;
  if (event.sequence !== state.sequence + 1) return null;
  const active = new Map((state.active ?? []).map((e) => [e.spanId, e]));
  if (event.spanId && ["running", "waiting"].includes(event.status))
    active.set(event.spanId, event);
  else active.delete(event.spanId);
  if (active.size > 1000) active.delete(active.keys().next().value);
  return {
    ...state,
    active: [...active.values()],
    sequence: event.sequence,
    events: [...state.events, event].slice(-1000),
  };
}
export function spans(events: Observation[]) {
  const map = new Map<string, Observation & { start: number }>();
  for (const e of events) {
    const key = e.spanId ?? String(e.sequence);
    const old = map.get(key);
    map.set(key, {
      ...old,
      ...e,
      reason: e.reason,
      start:
        e.startedAt ??
        (e.spanId === `task-${e.taskId}` && old?.status !== e.status
          ? e.at
          : (old?.start ?? e.at)),
    });
  }
  return [...map.values()];
}
