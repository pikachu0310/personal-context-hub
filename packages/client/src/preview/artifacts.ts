import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { HttpError } from "@ido/common/runtime/http";

const limit = 2 * 1024 * 1024;
export const artifactPolicy =
  "sandbox allow-scripts allow-pointer-lock; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return (
    !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  );
};

export async function readArtifact(directory: string, path: string) {
  if (
    !path ||
    isAbsolute(path) ||
    !/\.html?$/i.test(path) ||
    path.split(/[\\/]/).some((p) => p.startsWith("."))
  )
    throw new HttpError(400, "INVALID_ARTIFACT_PATH");
  const root = await realpath(directory);
  const target = await realpath(join(root, path)).catch(() => "");
  if (!within(root, target)) throw new HttpError(404, "ARTIFACT_NOT_FOUND");
  const file = await open(target, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit)
      throw new HttpError(413, "ARTIFACT_TOO_LARGE");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > limit) throw new HttpError(413, "ARTIFACT_TOO_LARGE");
    return {
      path,
      html: buffer.subarray(0, length).toString("utf8"),
      updatedAt: info.mtimeMs,
    };
  } finally {
    await file.close();
  }
}

export async function listArtifacts(directory: string) {
  const root = await realpath(directory);
  const found: { path: string; title?: string; updatedAt: number }[] = [];
  let visited = 0;
  async function walk(folder: string, depth: number) {
    const entries = await readdir(folder, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (++visited > 600 || found.length >= 24) return;
      if (
        entry.name.startsWith(".") ||
        entry.isSymbolicLink() ||
        ["node_modules", "vendor", "coverage"].includes(entry.name)
      )
        continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory() && depth < 2) await walk(path, depth + 1);
      else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
        const rel = relative(root, path).split(sep).join("/");
        const value = await readArtifact(root, rel).catch(() => undefined);
        if (value) {
          const title = /<title[^>]*>([^<]{1,300})<\/title>/i
            .exec(value.html)?.[1]
            ?.replace(/\s+/g, " ")
            .trim()
            .slice(0, 100);
          found.push({ path: rel, title, updatedAt: value.updatedAt });
        }
      }
    }
  }
  await walk(root, 0);
  return found.sort((a, b) => b.updatedAt - a.updatedAt);
}
