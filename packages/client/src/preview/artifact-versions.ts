import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "@ido/common/runtime/http";

type ArtifactVersion = {
  id: string;
  path: string;
  updatedAt: number;
  savedAt: number;
  html: string;
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const folder = (directory: string, runId: string) =>
  join(directory, "artifact-versions", hash(runId));
const metadata = ({ html: _html, ...value }: ArtifactVersion) => value;

export async function readArtifactVersion(
  directory: string,
  runId: string,
  version: string,
): Promise<ArtifactVersion> {
  if (!/^[a-f0-9]{64}$/.test(version))
    throw new HttpError(400, "INVALID_ARTIFACT_VERSION");
  const file = await open(
    join(folder(directory, runId), `${version}.json`),
    "r",
  ).catch(() => undefined);
  if (!file) throw new HttpError(404, "ARTIFACT_VERSION_NOT_FOUND");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 14 * 1024 * 1024)
      throw new HttpError(413, "ARTIFACT_TOO_LARGE");
    return JSON.parse(await file.readFile("utf8")) as ArtifactVersion;
  } finally {
    await file.close();
  }
}

export async function listArtifactVersions(directory: string, runId: string) {
  const names = await readdir(folder(directory, runId)).catch(() => []);
  const versions = await Promise.all(
    names
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) =>
        readArtifactVersion(directory, runId, name.slice(0, -5))
          .then(metadata)
          .catch(() => undefined),
      ),
  );
  return versions
    .filter((value) => value !== undefined)
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function saveArtifactVersion(
  directory: string,
  runId: string,
  artifact: { path: string; html: string; updatedAt: number },
) {
  const id = hash(`${artifact.path}\0${artifact.html}`);
  const existing = await readArtifactVersion(directory, runId, id).catch(
    () => undefined,
  );
  const version = existing ?? { ...artifact, id, savedAt: Date.now() };
  if (!existing) {
    const target = folder(directory, runId);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const temporary = join(target, `${id}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(version), { mode: 0o600 });
    await rename(temporary, join(target, `${id}.json`));
    const versions = await listArtifactVersions(directory, runId);
    for (const old of versions.slice(12))
      await unlink(join(target, `${old.id}.json`)).catch(() => {});
  }
  return {
    version: metadata(version),
    versions: await listArtifactVersions(directory, runId),
  };
}

export async function removeArtifactVersions(directory: string, runId: string) {
  const target = folder(directory, runId);
  const names = await readdir(target).catch(() => []);
  for (const name of names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)))
    await unlink(join(target, name));
}
