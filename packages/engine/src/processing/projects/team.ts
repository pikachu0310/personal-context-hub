import { MAX_MINUTES_LENGTH } from "@ido/common/contracts/api";
import {
  seedParticipants,
  taskBusy,
  taskParticipants,
} from "./task-participants.js";
import { deviceIdentity } from "../../clients/identity.js";
import { randomBytes } from "node:crypto";
import { hash } from "@ido/common/runtime/platform";
import {
  avatar,
  id,
  text,
  type Project,
  type Task,
  type ClientProfile,
} from "@ido/common/contracts/protocol";
import type { Repository } from "../../ports/repository.js";
import type { Device, Meeting } from "../../domain/models.js";
import { DEFAULT_PROJECT, Projects } from "./service.js";
export class ProjectTeam {
  constructor(readonly store: Repository) {}
  approved(deviceId: string) {
    const device = this.store.get<Device>("device", deviceId);
    if (!device || device.revoked) throw new Error("DEVICE_APPROVAL_REQUIRED");
    return device;
  }
  join(deviceId: string, projectId: string) {
    this.approved(deviceId);
    new Projects(this.store).project(projectId);
    this.store.put("project-member", `${projectId}:${deviceId}`, {
      projectId,
      deviceId,
    });
  }
  require(deviceId: string, projectId: string) {
    this.approved(deviceId);
    if (this.store.get("project-lock", projectId))
      throw new Error("WORKSPACE_CONFLICT");
    if (!this.store.get("project-member", `${projectId}:${deviceId}`))
      throw new Error("PROJECT_INVITATION_REQUIRED");
  }
  projects(deviceId: string): Project[] {
    this.approved(deviceId);
    const joined = new Set(
      this.store
        .list<{ projectId: string; deviceId: string }>("project-member")
        .filter((m) => m.deviceId === deviceId)
        .map((m) => m.projectId),
    );
    return this.store.list<Project>("project").filter((p) => joined.has(p.id));
  }
  own(deviceId: string, projectId: string) {
    this.approved(deviceId);
    const project = this.store.get<Project>("project", projectId)!;
    if (!project.ownerDeviceId && !project.isDefault) {
      project.ownerDeviceId = deviceId;
      this.store.put("project", projectId, project);
    }
    this.join(deviceId, projectId);
    return project;
  }
  owner(deviceId: string, projectId: string) {
    this.require(deviceId, projectId);
    if (
      this.store.get<Project>("project", projectId)?.ownerDeviceId !== deviceId
    )
      throw new Error("PROJECT_OWNER_REQUIRED");
  }
  remove(deviceId: string, projectId: string, targetId: string) {
    this.owner(deviceId, projectId);
    if (targetId === deviceId) throw new Error("OWNER_CANNOT_REMOVE_SELF");
    this.store.remove("project-member", `${projectId}:${targetId}`);
    this.store.put("project-removal", `${projectId}:${targetId}`, {
      projectId,
      deviceId: targetId,
      at: Date.now(),
    });
    const target = this.store.get<Device>("device", targetId);
    if (target) {
      target.grants = target.grants.filter((g) => g.projectId !== projectId);
      this.store.put("device", target.id, target);
    }
    return { ok: true };
  }
  transfer(
    deviceId: string,
    projectId: string,
    targetId: string,
    version: unknown,
  ) {
    return this.store.transaction(() => {
      this.owner(deviceId, projectId);
      this.require(targetId, projectId);
      const project = this.store.get<Project>("project", projectId)!;
      if (version !== (project.membershipVersion ?? 0))
        throw new Error("WORKSPACE_CONFLICT");
      if (targetId === deviceId) throw new Error("INVALID_OWNER");
      project.ownerDeviceId = targetId;
      project.membershipVersion = (project.membershipVersion ?? 0) + 1;
      this.store.put("project", projectId, project);
      return project;
    });
  }
  leave(deviceId: string, projectId: string, version: unknown) {
    return this.store.transaction(() => {
      this.require(deviceId, projectId);
      const project = this.store.get<Project>("project", projectId)!;
      if (version !== (project.membershipVersion ?? 0))
        throw new Error("WORKSPACE_CONFLICT");
      if (project.ownerDeviceId === deviceId)
        throw new Error("OWNER_TRANSFER_REQUIRED");
      const tasks = this.store
        .list<Task>("task")
        .filter((t) => t.projectId === projectId);
      if (tasks.some((t) => t.clientId === deviceId && taskBusy(t)))
        throw new Error("PROJECT_TASKS_ACTIVE");
      for (const task of tasks) {
        seedParticipants(this.store, task);
        task.memberStates![deviceId] = false;
        task.membershipVersion = (task.membershipVersion ?? 0) + 1;
        this.store.put("task", task.id, task);
      }
      this.store.remove("project-member", `${projectId}:${deviceId}`);
      this.store.put("project-exit", `${projectId}:${deviceId}`, {
        projectId,
        deviceId,
      });
      const device = this.approved(deviceId);
      device.grants = device.grants.filter((g) => g.projectId !== projectId);
      this.store.put("device", deviceId, device);
      return { ok: true };
    });
  }
  profile(deviceId: string, input: unknown) {
    const device = this.approved(deviceId);
    const value = input as Partial<ClientProfile>;
    const profile: ClientProfile = {
      avatar: avatar(value?.avatar),
      name: text(value?.name || "参加者", 100),
      context:
        typeof value?.context === "string" ? value.context.slice(0, 8000) : "",
      codexConnected: value?.codexConnected === true,
    };
    device.profile = profile;
    device.name = profile.name;
    device.codexConnected = profile.codexConnected;
    this.store.put("device", device.id, device);
    this.store.put("participant", `client-${device.id}`, {
      id: `client-${device.id}`,
      name: profile.name,
      role: "member",
    });
    if (
      !this.store.get("project-exit", `${DEFAULT_PROJECT}:${deviceId}`) &&
      !this.store.get("project-removal", `${DEFAULT_PROJECT}:${deviceId}`)
    )
      // Default cannot be deleted; a task context reset must not reject profile/reconnect.
      this.store.put("project-member", `${DEFAULT_PROJECT}:${deviceId}`, {
        projectId: DEFAULT_PROJECT,
        deviceId,
      });
    return profile;
  }
  participants(projectId: string) {
    const members = this.store
      .list<{ projectId: string; deviceId: string }>("project-member")
      .filter((m) => m.projectId === projectId);
    return members.flatMap((m) => {
      const device = this.store.get<Device>("device", m.deviceId);
      return device && !device.revoked
        ? [
            {
              id: device.id,
              identityId: deviceIdentity(this.store, device),
              name: device.profile?.name ?? device.name,
              avatar: device.profile?.avatar,
              context: device.profile?.context ?? "",
              codexConnected: device.codexConnected === true,
            },
          ]
        : [];
    });
  }
  invite(deviceId: string, projectId: string) {
    this.require(deviceId, projectId);
    return this.issueInvite(projectId);
  }
  issueInvite(projectId: string) {
    new Projects(this.store).project(projectId);
    const token = randomBytes(32).toString("base64url");
    this.store.put("project-invite", hash(token), {
      projectId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 86400000,
    });
    return { token, projectId };
  }
  joinInvitation(deviceId: string, token: string) {
    const project = this.invitation(token);
    const invitation = this.store.get<{ createdAt: number }>(
      "project-invite",
      hash(token),
    )!;
    const removal = this.store.get<{ at: number }>(
      "project-removal",
      `${project.id}:${deviceId}`,
    );
    if (removal && invitation.createdAt <= removal.at)
      throw new Error("NEW_INVITATION_REQUIRED");
    this.join(deviceId, project.id);
    return project;
  }
  invitation(token: string) {
    const invitation = this.store.get<{
      projectId: string;
      createdBy: string;
      expiresAt: number;
    }>("project-invite", hash(text(token, 200)));
    if (!invitation || invitation.expiresAt < Date.now())
      throw new Error("INVITATION_EXPIRED");

    const project = this.store.get<Project>("project", invitation.projectId);
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    return project;
  }
  rename(deviceId: string, projectId: string, name: unknown) {
    this.owner(deviceId, projectId);
    const project = this.store.get<Project>("project", id(projectId))!;
    if (project.isDefault) throw new Error("DEFAULT_PROJECT_NAME_FIXED");
    const normalized = text(text(name, 100).normalize("NFKC"), 100);
    if (
      this.store
        .list<Project>("project")
        .some(
          (p) =>
            p.id !== projectId &&
            p.name.normalize("NFKC").toLowerCase() === normalized.toLowerCase(),
        )
    )
      throw new Error("PROJECT_NAME_EXISTS");
    project.name = normalized;
    this.store.put("project", project.id, project);
    return project;
  }
  updateMinutes(deviceId: string, input: Record<string, unknown>) {
    return this.store.transaction(() => {
      const projectId = id(input.projectId),
        meetingId = id(input.meetingId);
      this.require(deviceId, projectId);
      if (!this.canEditMinutes(deviceId)) throw new Error("PERMISSION_DENIED");
      const meeting = this.store.get<Meeting>("meeting", meetingId);
      if (!meeting || meeting.projectId !== projectId)
        throw new Error("MEETING_NOT_FOUND");
      if (
        typeof input.markdown !== "string" ||
        input.markdown.length > MAX_MINUTES_LENGTH
      )
        throw new Error("INVALID_MINUTES");
      if (
        !Number.isSafeInteger(input.expectedRevision) ||
        Number(input.expectedRevision) < 0
      )
        throw new Error("INVALID_REVISION");
      if ((meeting.summaryRevision ?? 0) !== input.expectedRevision)
        throw new Error("MINUTES_CONFLICT");
      meeting.summary = input.markdown;
      meeting.summaryContextRevision = this.store.get<{ revision: number }>(
        "project-context",
        projectId,
      )?.revision;
      meeting.summaryRevision = (meeting.summaryRevision ?? 0) + 1;
      meeting.summaryUpdatedAt = Date.now();
      this.store.put("meeting", meetingId, meeting);
      this.store.audit(
        `client-${deviceId}`,
        "project.minutes.update",
        meetingId,
      );
      return meeting;
    });
  }
  canEditMinutes(deviceId: string) {
    const device = this.approved(deviceId);
    const user = this.store.user(device.userId);
    return !!user && user.role !== "viewer";
  }
  snapshot(deviceId: string, projectId: string) {
    this.require(deviceId, projectId);
    return {
      project: this.store.get<Project>("project", projectId),
      canEditMinutes: this.canEditMinutes(deviceId),
      minutes: this.store
        .list<Meeting>("meeting")
        .filter((m) => m.projectId === projectId)
        .map((meeting) => ({
          ...meeting,
          messages: meeting.messages.map((message) => {
            const device = message.authorId.startsWith("client-")
              ? this.store.get<Device>("device", message.authorId.slice(7))
              : undefined;
            return {
              id: message.id,
              authorId: message.authorId,
              authorName: message.authorName,
              role: message.role,
              text: message.text,
              replyText: message.replyText,
              at: message.at,
              stage: message.stage,
              steps: message.steps,
              ...(device
                ? {
                    authorIdentityId: deviceIdentity(this.store, device),
                    authorName: device.profile?.name ?? device.name,
                  }
                : {}),
            };
          }),
        })),
      participants: this.participants(projectId),
      tasks: this.store
        .list<import("@ido/common/contracts/protocol").Task>("task")
        .filter((t) => t.projectId === projectId)
        .map((task) => ({
          ...task,
          participants: taskParticipants(this.store, task),
          canDelete:
            task.authorId === `client-${deviceId}` ||
            this.store.get<Project>("project", projectId)?.ownerDeviceId ===
              deviceId,
        })),
    };
  }
}
