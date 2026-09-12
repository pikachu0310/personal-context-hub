import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
const git = (cwd, args) =>
  exec("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 });
const sourceDiff = (cwd) =>
  git(cwd, [
    "diff",
    "--binary",
    "HEAD",
    "--",
    ".",
    ":(exclude).env*",
    ":(exclude)credentials/**",
  ]);
const digest = (value) => createHash("sha256").update(value).digest("hex");

// Worktrees retain changes for review. Never merge, reset, or delete a user's tree.
export class TaskWorkspaceManager {
  constructor({ repository, directory }) {
    this.repository = repository;
    this.directory = directory;
    this.preparing = Promise.resolve();
  }

  prepare(task) {
    const pending = this.preparing.then(() => this.#prepare(task));
    this.preparing = pending.catch(() => undefined);
    return pending;
  }

  async #prepare(task) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(task.id))
      throw new Error("Invalid task ID");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const root = await realpath(this.directory);
    const target = join(root, task.id);
    if (task.workingDirectory) {
      const actual = await realpath(task.workingDirectory);
      if (actual !== target)
        throw new Error("Task workspace is outside its configured root");
      await git(actual, ["rev-parse", "--show-toplevel"]);
      return actual;
    }
    const source = (
      await git(this.repository, ["rev-parse", "--show-toplevel"])
    ).stdout.trim();
    const rel = relative(source, root);
    if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new Error("Task workspaces must be outside the source repository");
    }
    const base = (await git(source, ["rev-parse", "HEAD"])).stdout.trim();
    await git(source, ["worktree", "add", "--detach", target, base]);
    // Include tracked local edits, but never copy ignored credentials or raw data.
    const patch = (await sourceDiff(source)).stdout;
    if (patch) {
      const patchPath = join(root, `${task.id}-baseline.patch`);
      await writeFile(patchPath, patch, { mode: 0o600 });
      await git(target, ["apply", patchPath]);
    }
    task.workingDirectory = target;
    task.baseCommit = base;
    task.baselineFingerprint = digest(patch);
    await git(target, ["add", "--update"]);
    task.baselineTree = (await git(target, ["write-tree"])).stdout.trim();
    return target;
  }

  async collect(task) {
    if (!task.workingDirectory) return undefined;
    const target = await this.prepare(task);
    const untracked = (
      await git(target, ["ls-files", "--others", "--exclude-standard", "-z"])
    ).stdout
      .split("\0")
      .filter(Boolean)
      .filter(
        (path) =>
          !/(?:^|\/)(?:\.env[^/]*|credentials|\.codex|logs?|cache)(?:\/|$)|\.(?:log|jsonl|sqlite|db|wav|pcm)$/i.test(
            path,
          ),
      );
    if (untracked.length)
      await git(target, ["add", "--intent-to-add", "--", ...untracked]);
    const diff = (
      await git(target, [
        "diff",
        "--binary",
        task.baselineTree ?? "HEAD",
        "--",
        ".",
        ":(exclude).env*",
        ":(exclude)credentials/**",
      ])
    ).stdout;
    const status = (await git(target, ["status", "--short"])).stdout.trim();
    const patchPath = join(this.directory, `${task.id}-result.patch`);
    await writeFile(patchPath, diff, { mode: 0o600 });
    return {
      workingDirectory: target,
      baseCommit: task.baseCommit,
      patchPath,
      status,
      note: "Patch is relative to the task's starting snapshot. Review before applying.",
    };
  }

  apply(task) {
    const pending = this.preparing.then(async () => {
      if (!task.baselineFingerprint || !task.artifacts?.patchPath)
        throw new Error("This task has no applicable snapshot.");
      const head = (
        await git(this.repository, ["rev-parse", "HEAD"])
      ).stdout.trim();
      const current = (await sourceDiff(this.repository)).stdout;
      if (
        head !== task.baseCommit ||
        digest(current) !== task.baselineFingerprint
      )
        throw new Error(
          "Source changed since this task started. Review and reconcile the patch first.",
        );
      await git(this.repository, [
        "apply",
        "--check",
        task.artifacts.patchPath,
      ]);
      await git(this.repository, ["apply", task.artifacts.patchPath]);
      task.applied = true;
      return true;
    });
    this.preparing = pending.catch(() => undefined);
    return pending;
  }
}

export function selectTaskProfile(task, config) {
  const kind = ["research", "implementation", "benchmark", "test"].includes(
    task.kind,
  )
    ? task.kind
    : "implementation";
  const complex = task.complexity === "complex";
  return {
    kind,
    model: complex
      ? (config.complexTaskModel ?? config.taskModel ?? config.codexModel)
      : (config.taskModel ?? config.codexModel),
    modelReasoningEffort: complex
      ? (config.complexTaskReasoningEffort ?? "high")
      : (config.taskReasoningEffort ?? "medium"),
    sandboxMode: "workspace-write",
    networkAccessEnabled: true,
    webSearchMode: "live",
  };
}
