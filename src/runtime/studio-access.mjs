import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export async function readStudioAccess(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const access = {
      operatorCode: randomBytes(32).toString("base64url"),
      viewerCode: randomBytes(32).toString("base64url"),
    };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(access), { mode: 0o600, flag: "wx" });
    return access;
  }
}
