import type {
  DashboardState,
  DashboardTask,
  DashboardRawPage,
} from "@ido/common/contracts/api";
import {
  clean,
  type Task,
  type Project,
  type User,
} from "@ido/common/contracts/protocol";
import {
  requiresPolicySupport,
  restrictExecutionPolicy,
} from "@ido/common/contracts/work";
import { HttpError } from "@ido/common/runtime/http";
import type { Engine } from "../../bootstrap/engine.js";
import type { Device, Meeting, Message } from "../../domain/models.js";

const occupied = (t: Task) =>
  ["assigned", "running", "interrupted"].includes(t.state);
export function dashboardSnapshot(
  engine: Engine,
  user: User,
  projectId?: string,
): DashboardState {
  const now = Date.now(),
    store = engine.store;
  const projects = store.list<Project>("project");
  if (projectId && !projects.some((p) => p.id === projectId))
    throw new HttpError(404, "PROJECT_NOT_FOUND");
  const devices = store.list<Device>("device").filter((d) => !d.revoked);
  const members = store.list<{ projectId: string; deviceId: string }>(
    "project-member",
  );
  const users = store.users();
  const allTasks = store.list<Task>("task");
  const tasks = allTasks.filter((t) => !projectId || t.projectId === projectId);
  const meetings = store
    .list<Meeting>("meeting")
    .filter((m) => !projectId || m.projectId === projectId);
  const meetingProjects = new Map(meetings.map((m) => [m.id, m.projectId]));
  const messages = store
    .list<Message>("message")
    .filter((m) => meetingProjects.has(m.meetingId));
  const connections = devices
    .filter(
      (d) =>
        !projectId ||
        members.some((m) => m.deviceId === d.id && m.projectId === projectId),
    )
    .map((d) => {
      const session = engine.connections.sessions.get(d.id);
      return {
        id: d.id,
        name: clean(d.name),
        userId: d.userId,
        generation: d.generation,
        connected: engine.peers.has(d.id),
        ready:
          engine.ready.has(d.id) && !!d.codexConnected && d.grants.length > 0,
        disconnecting: !!session?.disconnecting,
        connectedAt: session?.connectedAt,
        lastSeenAt: session?.lastSeenAt,
        slots: d.slots,
        projectIds: members
          .filter((m) => m.deviceId === d.id)
          .map((m) => m.projectId),
      };
    });
  const projectedTasks: DashboardTask[] = tasks.map((t) => {
    const device = devices.find((d) => d.id === t.clientId);
    const retriedAtVersion = Object.values(t.controlReceipts ?? {})
      .filter((r) => r.type === "retry")
      .reduce((max, r) => Math.max(max, r.controlVersion), 0);
    const stop = Object.values(t.controlReceipts ?? {})
      .filter((r) => r.type === "stop" && r.controlVersion > retriedAtVersion)
      .sort((a, b) => b.controlVersion - a.controlVersion)[0];
    let waitReason: string | undefined;
    if (t.state === "queued") {
      const eligible = devices.filter(
        (d) =>
          engine.ready.has(d.id) &&
          d.codexConnected &&
          members.some(
            (m) => m.deviceId === d.id && m.projectId === t.projectId,
          ) &&
          d.grants.some(
            (g) => g.projectId === t.projectId && (!t.network || g.network),
          ) &&
          (!requiresPolicySupport(
            restrictExecutionPolicy(
              t.executionPolicy,
              t.effectiveExecutionPolicy,
            ),
          ) ||
            d.executionPolicyVersion === 1),
      );
      waitReason = eligible.length ? "実行枠待ち" : "実行可能な接続なし";
    } else if (occupied(t) && (!device || !engine.ready.has(device.id)))
      waitReason = "実行先未接続";
    else if (t.state === "assigned") waitReason = "実行開始待ち";
    else if (t.state === "interrupted") waitReason = "実行状態の確認が必要";
    return {
      id: t.id,
      runId: t.runId,
      revision: t.revision,
      controlVersion: t.controlVersion ?? 0,
      projectId: t.projectId,
      meetingId: t.meetingId,
      title: clean(t.title || t.text.slice(0, 120)),
      state: t.state,
      clientId: t.clientId,
      userId: device?.userId,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      assignedAt: t.assignedAt,
      assignmentReason: t.assignmentReason
        ? clean(t.assignmentReason)
        : undefined,
      waitReason,
      stop: stop ? { delivery: stop.delivery } : undefined,
    };
  });
  const from = now - 3600000;
  const buckets = Array.from({ length: 12 }, (_, i) => ({
    at: from + i * 300000,
    count: 0,
  }));
  for (const m of messages)
    if (
      m.at >= from &&
      m.at < now &&
      m.role !== "assistant" &&
      m.complete !== false &&
      m.text.trim()
    )
      buckets[Math.floor((m.at - from) / 300000)].count++;
  const projectViews = projects.map((p) => {
    const ids = new Set(
      members.filter((m) => m.projectId === p.id).map((m) => m.deviceId),
    );
    const ds = devices.filter((d) => ids.has(d.id));
    const related = allTasks.filter((t) => t.projectId === p.id);
    const times = [
      ...related.map((t) => t.updatedAt),
      ...messages
        .filter((m) => meetingProjects.get(m.meetingId) === p.id)
        .map((m) => m.at),
    ];
    return {
      id: p.id,
      name: clean(p.name),
      userIds: [...new Set(ds.map((d) => d.userId))],
      connectedUserIds: [
        ...new Set(
          ds.filter((d) => engine.peers.has(d.id)).map((d) => d.userId),
        ),
      ],
      running: related.filter((t) => t.state === "running").length,
      waiting: related.filter((t) => ["queued", "assigned"].includes(t.state))
        .length,
      lastActivityAt: times.length
        ? times.reduce((a, b) => Math.max(a, b), 0)
        : undefined,
    };
  });
  const conversations = store.list<{
    projectId: string;
    meetingId: string;
    lastHumanAt?: number;
  }>("project-conversation");
  return {
    user,
    updatedAt: now,
    projects: projectViews,
    users: users.map((u) => ({ ...u, name: clean(u.name) })),
    connections,
    tasks: projectedTasks,
    meetings: meetings.map((m) => ({
      id: m.id,
      projectId: m.projectId,
      name: clean(m.name),
      startedAt: m.startedAt,
      closedAt: m.closedAt,
    })),
    counts: {
      running: tasks.filter((t) => t.state === "running").length,
      waiting: tasks.filter((t) => ["queued", "assigned"].includes(t.state))
        .length,
      connectedUsers: new Set(
        connections.filter((c) => c.connected).map((c) => c.userId),
      ).size,
      activeConversations: conversations.filter(
        (c) =>
          (!projectId || c.projectId === projectId) &&
          (c.lastHumanAt ?? 0) >= now - 300000 &&
          meetings.some((m) => m.id === c.meetingId && !m.closedAt),
      ).length,
      projects: projectId ? 1 : projects.length,
    },
    activity: {
      from,
      to: now,
      observedFrom: Math.max(
        from,
        meetings.reduce((min, m) => Math.min(min, m.startedAt ?? now), now),
      ),
      total: buckets.reduce((sum, b) => sum + b.count, 0),
      buckets,
    },
  };
}

/** Bounded, allowlisted raw views; never serialize arbitrary stored records. */
export function dashboardRaw(
  engine: Engine,
  query: URLSearchParams,
): DashboardRawPage {
  const kind = query.get("kind") || "messages",
    projectId = query.get("projectId"),
    target = query.get("target") || "";
  const from = Number(query.get("from") || Date.now() - 3600000),
    to = Number(query.get("to") || Date.now());
  const offset = Number(query.get("offset") || 0),
    limit = 50;
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from > to ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1000000
  )
    throw new HttpError(400, "INVALID_FILTER");
  const meetings = engine.store.list<Meeting>("meeting");
  const projects = new Map(meetings.map((m) => [m.id, m.projectId]));
  let rows: DashboardRawPage["items"];
  if (kind === "messages")
    rows = engine.store.list<Message>("message").map((m) => ({
      id: m.id,
      at: m.at,
      projectId: projects.get(m.meetingId),
      targetId: m.meetingId,
      text: JSON.stringify({
        id: m.id,
        meetingId: m.meetingId,
        authorId: m.authorId,
        authorName: m.authorName ? clean(m.authorName) : undefined,
        role: m.role ?? "user",
        text: clean(m.text),
        replyText: m.replyText ? clean(m.replyText) : undefined,
        stage: m.stage,
      }),
    }));
  else if (kind === "minutes")
    rows = meetings.map((m) => ({
      id: m.id,
      at:
        m.closedAt ??
        m.messages.reduce((last, v) => Math.max(last, v.at), m.startedAt ?? 0),
      projectId: m.projectId,
      targetId: m.id,
      text: clean(m.summary),
    }));
  else if (kind === "events") {
    const tasks = new Map(
      engine.store.list<Task>("task").map((t) => [t.id, t]),
    );
    rows = (
      engine.store.db
        .prepare(
          "SELECT seq,at,action,target,actor FROM audit WHERE at>=? AND at<=? ORDER BY seq DESC",
        )
        .all(from, to) as unknown as Array<{
        seq: number;
        at: number;
        action: string;
        target: string;
        actor: string;
      }>
    ).map((e) => ({
      id: String(e.seq),
      at: e.at,
      projectId: tasks.get(e.target)?.projectId,
      targetId: e.target,
      text: JSON.stringify({
        action: clean(e.action),
        actor: e.actor,
        target: clean(e.target),
      }),
    }));
  } else throw new HttpError(400, "INVALID_RAW_KIND");
  rows = rows
    .filter(
      (r) =>
        r.at >= from &&
        r.at <= to &&
        (!projectId || r.projectId === projectId) &&
        (!target || r.targetId === target || r.id === target),
    )
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return {
    items: rows.slice(offset, offset + limit),
    total: rows.length,
    offset,
    limit,
  };
}
