import { readdir, realpath } from "node:fs/promises";
import { run } from "@ido/common/runtime/platform";
import { HttpError } from "@ido/common/runtime/http";
export async function projectDirectory(path: string) {
  const directory = await realpath(path);
  const entries = await readdir(directory);
  if (!entries.length) {
    await run("git", ["-c", "init.templateDir=", "init", directory]);
    await run("git", [
      "-C",
      directory,
      "-c",
      "core.hooksPath=",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=IDO",
      "-c",
      "user.email=ido@localhost",
      "commit",
      "--allow-empty",
      "--no-verify",
      "-m",
      "Initialize project",
    ]);
  }
  try {
    const root = await run("git", [
      "-C",
      directory,
      "rev-parse",
      "--show-toplevel",
    ]);
    if ((await realpath(root)) !== directory) throw new Error("NOT_ROOT");
    await run("git", ["-C", directory, "rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new HttpError(
      400,
      "PROJECT_DIRECTORY_REQUIRES_EMPTY_OR_COMMITTED_REPO",
    );
  }
  return directory;
}
