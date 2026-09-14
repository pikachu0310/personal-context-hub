import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  writeFile,
  realpath,
  readFile,
  lstat,
  readlink,
  unlink,
} from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  automaticVoiceModel,
  taskModelSelection,
} from "../../engine/model-policy.mjs";

const exec = promisify(execFile);
const git = (cwd, args, options = {}) =>
  exec("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024, ...options });
const patchExclusions = [
  ":(exclude).env*",
  ":(exclude)credentials/**",
  ":(glob,exclude)**/.env*",
  ":(glob,exclude)**/credentials/**",
];
const sourceDiff = (cwd) =>
  git(cwd, ["diff", "--binary", "HEAD", "--", ".", ...patchExclusions]);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const eligibleNewFile = (path) =>
  !/(?:^|\/)(?:\.env[^/]*|credentials|\.codex|logs?|cache)(?:\/|$)|\.(?:log|jsonl|sqlite|db|wav|pcm)$/i.test(
    path,
  );

async function fileFingerprint(repository, path) {
  const target = join(repository, path);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) return "link:" + digest(await readlink(target));
    if (info.isFile())
      return `${info.mode & 0o111}:` + digest(await readFile(target));
    return "directory";
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
}

function applyPatch(repository, args, patch) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-C", repository, "apply", ...args, "-"],
      { maxBuffer: 8 * 1024 * 1024 },
      (error) => (error ? reject(error) : resolve()),
    );
    child.stdin.on("error", () => undefined);
    child.stdin.end(patch);
  });
}

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
      const top = await realpath(
        (await git(actual, ["rev-parse", "--show-toplevel"])).stdout.trim(),
      );
      const common = async (cwd) =>
        realpath(
          (
            await git(cwd, [
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ])
          ).stdout.trim(),
        );
      if (
        top !== actual ||
        (await common(actual)) !== (await common(this.repository))
      )
        throw new Error("Task worktree belongs to a different repository");
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
    task.baselineTree = await this.#snapshot(target, base);
    await git(target, [
      "update-ref",
      `refs/idobata/${task.id}/baseline`,
      task.baselineTree,
    ]);
    return target;
  }

  async #snapshot(target, base) {
    const index = join(this.directory, `.snapshot-${randomUUID()}.index`);
    const options = { env: { ...process.env, GIT_INDEX_FILE: index } };
    try {
      await git(target, ["read-tree", base], options);
      await git(
        target,
        ["add", "--update", "--", ".", ...patchExclusions],
        options,
      );
      const untracked = (
        await git(
          target,
          ["ls-files", "--others", "--exclude-standard", "-z"],
          options,
        )
      ).stdout
        .split("\0")
        .filter(Boolean)
        .filter(eligibleNewFile);
      if (untracked.length)
        await git(target, ["add", "--", ...untracked], options);
      return (await git(target, ["write-tree"], options)).stdout.trim();
    } finally {
      await unlink(index).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async collect(task) {
    if (!task.workingDirectory) return undefined;
    const target = await this.prepare(task);
    const fromTree = task.baselineTree ?? "HEAD";
    const resultTree = await this.#snapshot(target, fromTree);
    const diff = (
      await git(target, [
        "diff",
        "--binary",
        fromTree,
        resultTree,
        "--",
        ".",
        ...patchExclusions,
      ])
    ).stdout;
    const status = (
      await git(target, ["diff", "--name-status", fromTree, resultTree])
    ).stdout.trim();
    const runRevision = task.runRevision ?? 1;
    if (!Number.isSafeInteger(runRevision) || runRevision < 1)
      throw new Error("Invalid result revision");
    const patchPath = join(
      this.directory,
      `${task.id}-result-${runRevision}.patch`,
    );
    try {
      await writeFile(patchPath, diff, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (
        error.code !== "EEXIST" ||
        (await readFile(patchPath, "utf8")) !== diff
      )
        throw error;
    }
    await git(target, [
      "update-ref",
      `refs/idobata/${task.id}/results/${runRevision}`,
      resultTree,
    ]);
    return {
      workingDirectory: target,
      baseCommit: task.baseCommit,
      patchPath,
      runRevision,
      patchHash: digest(diff),
      hasChanges: Boolean(diff),
      fromTree,
      resultTree,
      status,
      note: "Patch is relative to the last applied snapshot, or the task's starting snapshot. Review this revision before applying.",
    };
  }

  apply(task) {
    const pending = this.preparing.then(async () => {
      if (
        task.appliedRevision === task.artifacts?.runRevision &&
        task.appliedRevision
      )
        return false;
      if (
        !task.baselineFingerprint ||
        !task.artifacts?.patchPath ||
        !task.artifacts.patchHash ||
        !task.artifacts.resultTree
      )
        throw new Error("This task has no applicable snapshot.");
      if (task.artifacts.fromTree !== task.baselineTree)
        throw new Error(
          "Artifact baseline changed; review the latest revision.",
        );
      const patch = await readFile(task.artifacts.patchPath);
      if (digest(patch) !== task.artifacts.patchHash)
        throw new Error("Saved patch integrity check failed.");
      if (!patch.length) return false;
      const head = (
        await git(this.repository, ["rev-parse", "HEAD"])
      ).stdout.trim();
      const current = (await sourceDiff(this.repository)).stdout;
      const appliedFilesMatch = (
        await Promise.all(
          Object.entries(task.appliedFileState ?? {}).map(
            async ([path, fingerprint]) =>
              (await fileFingerprint(this.repository, path)) === fingerprint,
          ),
        )
      ).every(Boolean);
      if (
        head !== task.baseCommit ||
        digest(current) !== task.baselineFingerprint ||
        !appliedFilesMatch
      )
        throw new Error(
          "Source changed since this task started. Review and reconcile the patch first.",
        );
      await applyPatch(this.repository, ["--check"], patch);
      await applyPatch(this.repository, [], patch);
      const paths = (
        await git(this.repository, [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          task.baselineTree,
          task.artifacts.resultTree,
        ])
      ).stdout
        .split("\0")
        .filter(Boolean);
      task.appliedFileState ??= {};
      for (const path of paths)
        task.appliedFileState[path] = await fileFingerprint(
          this.repository,
          path,
        );
      task.baselineFingerprint = digest(
        (await sourceDiff(this.repository)).stdout,
      );
      task.baselineTree = task.artifacts.resultTree;
      await git(this.repository, [
        "update-ref",
        `refs/idobata/${task.id}/baseline`,
        task.baselineTree,
      ]);
      task.appliedRevision = task.artifacts.runRevision;
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
  const agent = task.assignedAgent;
  const selected = taskModelSelection(task);
  return {
    kind,
    model:
      selected?.model ??
      automaticVoiceModel(
        agent?.model ??
          (complex
            ? (config.complexTaskModel ?? config.taskModel ?? config.codexModel)
            : (config.taskModel ?? config.codexModel)),
      ),
    modelReasoningEffort:
      selected?.reasoningEffort ??
      agent?.reasoningEffort ??
      (complex
        ? (config.complexTaskReasoningEffort ??
          config.taskReasoningEffort ??
          config.codexReasoningEffort ??
          "low")
        : (config.taskReasoningEffort ?? config.codexReasoningEffort ?? "low")),
    sandboxMode: "workspace-write",
    networkAccessEnabled: true,
    webSearchMode: "live",
  };
}
