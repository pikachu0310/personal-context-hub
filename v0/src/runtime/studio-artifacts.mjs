import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { StudioError } from "../adapters/browser/controller.mjs";

const exec = promisify(execFile);
const limit = 8 * 1024 * 1024;
const objectId = (value) => /^[a-f0-9]{40,64}$/.test(value ?? "");
const shareable = (name) =>
  !/(?:^|\/)(?:\.env[^/]*|credentials|secrets?|\.ssh|\.aws|\.azure|\.codex|\.git|logs?|cache|auth\.json|id_rsa|id_ed25519)(?:\/|$)|\.(?:log|jsonl|sqlite|db|wav|pcm|pem|key|pfx|p12)$/i.test(
    name,
  );
const fileId = (name) =>
  createHash("sha256").update(name).digest("hex").slice(0, 24);

// Read only files changed in a saved result tree. Never serve a client path or
// the mutable worktree: another turn may already be editing it, or replacing a
// file with a symlink. Git blobs also keep the download tied to its result.
export function createStudioArtifactReader({ workspaceRoot }) {
  const git = async (cwd, args, binary = false) =>
    (
      await exec("git", ["-C", cwd, ...args], {
        encoding: binary ? "buffer" : "utf8",
        maxBuffer: limit,
        timeout: 10000,
        windowsHide: true,
      })
    ).stdout;
  return async (task, revision, requestedFile) => {
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revision !== task.resultMetadata?.runRevision
    )
      throw new StudioError(
        409,
        "届いた結果が更新されました。最新の結果を開いてください。",
      );
    const artifacts =
      task.resultDeliveries?.find((item) => item.runRevision === revision)
        ?.artifacts ??
      (task.artifacts?.runRevision === revision ? task.artifacts : undefined);
    if (
      !artifacts ||
      artifacts.remote ||
      !task.workingDirectory ||
      !objectId(artifacts.fromTree) ||
      !objectId(artifacts.resultTree)
    )
      return requestedFile
        ? Promise.reject(
            new StudioError(
              404,
              "この結果には取得できるファイルがありません。",
            ),
          )
        : { runRevision: revision, files: [], available: false };
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(task.id))
      throw new StudioError(404, "成果が見つかりません。");
    const root = await realpath(workspaceRoot);
    const cwd = await realpath(task.workingDirectory);
    if (cwd !== resolve(root, task.id))
      throw new StudioError(403, "この成果の作業場所は開けません。");
    const changed = (
      await git(cwd, [
        "diff-tree",
        "--no-commit-id",
        "--no-renames",
        "-r",
        "-z",
        "--name-only",
        "--diff-filter=AM",
        artifacts.fromTree,
        artifacts.resultTree,
      ])
    )
      .split("\0")
      .filter(Boolean)
      .filter(shareable);
    const paths = changed.slice(0, 200);
    const entries = paths.length
      ? (
          await git(cwd, [
            "--literal-pathspecs",
            "ls-tree",
            "-r",
            "-z",
            "-l",
            artifacts.resultTree,
            "--",
            ...paths,
          ])
        )
          .split("\0")
          .filter(Boolean)
          .flatMap((entry) => {
            const match = entry.match(
              /^(100644|100755) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/,
            );
            if (!match || !paths.includes(match[4])) return [];
            return [
              {
                id: fileId(match[4]),
                name: match[4],
                size: Number(match[3]),
                blob: match[2],
              },
            ];
          })
      : [];
    if (!requestedFile)
      return {
        runRevision: revision,
        available: true,
        truncated: changed.length > paths.length,
        files: entries.map(({ id, name, size }) => ({
          id,
          name,
          size,
          downloadable: size <= limit,
        })),
      };
    const entry = entries.find((item) => item.id === requestedFile);
    if (!entry)
      throw new StudioError(
        404,
        "この結果に含まれるファイルを選んでください。",
      );
    if (entry.size > limit)
      throw new StudioError(
        413,
        "8MBを超える成果はホストの作業場所から取得してください。",
      );
    const data = await git(cwd, ["cat-file", "blob", entry.blob], true);
    return { name: entry.name.split("/").at(-1), data };
  };
}
