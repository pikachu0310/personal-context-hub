import { spawn } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  implementationRemote,
  type Implementation,
} from "@ido/common/contracts/api";

export function git(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn("git", ["-c", "core.hooksPath=", ...args], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "",
      failed = false;
    const abort = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(abort, 60_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data) => {
      output += data;
      if (output.length > 2_000_000) abort();
    });
    child.on("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("GIT_UNAVAILABLE"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failed || code !== 0)
        reject(
          new Error(signal?.aborted ? "PREVIEW_STOPPED" : "GIT_FETCH_FAILED"),
        );
      else resolve(output.trim());
    });
  });
}
export type Git = typeof git;
export const repoKey = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export async function inspectImplementation(
  directory: string,
  execute: Git = git,
) {
  const inRepo = (...args: string[]) => execute(["-C", directory, ...args]);
  if (await inRepo("status", "--porcelain", "--untracked-files=normal"))
    return { availability: "uncommitted" as const };
  const commit = await inRepo("rev-parse", "HEAD");
  const remote = implementationRemote(
    await inRepo("remote", "get-url", "origin"),
  );
  const branch = await inRepo("symbolic-ref", "--short", "-q", "HEAD").catch(
    () => "",
  );
  const advertised = await execute([
    "ls-remote",
    "--refs",
    remote,
    "refs/heads/*",
    "refs/tags/*",
  ]);
  const refs = advertised
    .split("\n")
    .map((line) => line.split(/\s+/))
    .filter(
      ([sha, ref]) =>
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha) &&
        /^refs\/(heads|tags)\//.test(ref ?? ""),
    )
    .sort(
      (a, b) =>
        Number(b[1] === `refs/heads/${branch}`) -
        Number(a[1] === `refs/heads/${branch}`),
    );
  for (const [sha, ref] of refs) {
    const reachable =
      sha === commit ||
      (await inRepo("merge-base", "--is-ancestor", commit, sha).then(
        () => true,
        () => false,
      ));
    if (!reachable) continue;
    if (
      (await inRepo("rev-parse", "HEAD")) !== commit ||
      (await inRepo("status", "--porcelain", "--untracked-files=normal"))
    )
      return { availability: "uncommitted" as const };
    return { availability: "ready" as const, commit, remote, branch: ref };
  }
  return { availability: "unpushed" as const };
}

export class PreviewRepository {
  constructor(
    readonly root: string,
    readonly execute: Git = git,
  ) {}
  private jobs = new Map<string, Promise<string>>();
  prepare(
    artifact: Implementation,
    directory: string,
    mapping?: string,
    signal?: AbortSignal,
  ) {
    const remote = implementationRemote(artifact.remote);
    const key = repoKey(remote);
    const previous = this.jobs.get(key) ?? Promise.resolve("");
    const job = previous
      .catch(() => "")
      .then(async () => {
        signal?.throwIfAborted();
        let repository = join(this.root, key);
        if (mapping) {
          const mappedRemote = await this.execute(
            ["-C", mapping, "remote", "get-url", "origin"],
            signal,
          )
            .then(implementationRemote)
            .catch(() => "");
          if (mappedRemote === remote) repository = await realpath(mapping);
        }
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        try {
          await this.execute(
            ["-C", repository, "rev-parse", "--git-dir"],
            signal,
          );
        } catch {
          signal?.throwIfAborted();
          await this.execute(
            ["clone", "--bare", "--", remote, repository],
            signal,
          );
        }
        const ref = `refs/ido-previews/${repoKey(artifact.id)}`;
        await this.execute(
          [
            "-C",
            repository,
            "fetch",
            "--no-tags",
            "--",
            remote,
            `+${artifact.branch}:${ref}`,
          ],
          signal,
        ).catch(async () => {
          signal?.throwIfAborted();
          await this.execute(
            [
              "-C",
              repository,
              "fetch",
              "--no-tags",
              "--",
              remote,
              artifact.commit,
            ],
            signal,
          );
        });
        try {
          await this.execute(
            ["-C", repository, "cat-file", "-e", `${artifact.commit}^{commit}`],
            signal,
          );
        } catch {
          await this.execute(
            [
              "-C",
              repository,
              "fetch",
              "--no-tags",
              "--",
              remote,
              artifact.commit,
            ],
            signal,
          );
        }
        signal?.throwIfAborted();
        await mkdir(join(directory, ".."), { recursive: true, mode: 0o700 });
        const current = await this.execute(
          ["-C", directory, "rev-parse", "HEAD"],
          signal,
        ).catch(() => "");
        if (current) {
          if (
            current !== artifact.commit ||
            (await this.execute(
              ["-C", directory, "status", "--porcelain"],
              signal,
            ))
          )
            throw new Error("PREVIEW_WORKTREE_CHANGED");
        } else
          await this.execute(
            [
              "-C",
              repository,
              "worktree",
              "add",
              "--detach",
              directory,
              artifact.commit,
            ],
            signal,
          );
        return repository;
      });
    this.jobs.set(key, job);
    void job
      .finally(() => {
        if (this.jobs.get(key) === job) this.jobs.delete(key);
      })
      .catch(() => {});
    return job;
  }
  async remove(repository: string, directory: string) {
    if (await this.execute(["-C", directory, "status", "--porcelain"]))
      throw new Error("PREVIEW_WORKTREE_CHANGED");
    await this.execute(["-C", repository, "worktree", "remove", directory]);
  }
}
