import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentThreadOptions } from "./types.js";

export const claudeTools = ["Read", "Glob", "Grep", "Write", "Edit", "Bash"];
export async function claudeToolAllowed(
  tool: string,
  input: Record<string, unknown>,
  options: AgentThreadOptions,
  planning: boolean,
) {
  if (!claudeTools.includes(tool)) return false;
  const readOnly = planning || options.sandboxMode === "read-only";
  if (readOnly && ["Write", "Edit", "Bash"].includes(tool)) return false;
  // A shell cannot enforce a no-network promise without OS isolation.
  if (tool === "Bash")
    return options.networkAccessEnabled && typeof input.command === "string";
  const path = input.file_path ?? input.path ?? options.workingDirectory;
  if (typeof path !== "string") return false;
  const root = await realpath(options.workingDirectory);
  const target = resolve(root, path);
  const within = (path: string) => {
    const delta = relative(root, path);
    return (
      !isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${sep}`)
    );
  };
  if (
    !within(target) ||
    relative(root, target)
      .split(sep)
      .some(
        (part) =>
          part.toLowerCase() === ".git" || part.toLowerCase() === ".claude",
      )
  )
    return false;
  let existing = target;
  while (true) {
    try {
      return within(await realpath(existing));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        dirname(existing) === existing
      )
        return false;
      existing = dirname(existing);
    }
  }
}
