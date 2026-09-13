import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class MeetingStateStore {
  constructor(path, scope) {
    this.path = path;
    this.scope = scope;
    this.data = { version: 1, scope, meeting: {}, tasks: [] };
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      if (value.version !== 1 || value.scope !== this.scope)
        throw new Error("Meeting state scope/version mismatch");
      this.data = value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this.data;
  }

  async acquire() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    try {
      await writeFile(lockPath, String(process.pid), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(await readFile(lockPath, "utf8"));
      if (!Number.isInteger(pid) || pid < 1)
        throw new Error(
          "Meeting lock is invalid; inspect the local lock file.",
        );
      try {
        process.kill(pid, 0);
      } catch (failure) {
        if (failure.code !== "ESRCH") throw failure;
        await unlink(lockPath);
        return this.acquire();
      }
      throw new Error("This meeting profile is already running.");
    }
    this.locked = true;
  }

  async release() {
    await this.writing;
    if (this.locked) {
      this.locked = false;
      await unlink(`${this.path}.lock`).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  save(part) {
    this.data = { ...this.data, ...part, updatedAt: new Date().toISOString() };
    const serialized = JSON.stringify(this.data);
    const operation = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.writing = operation.catch(() => undefined);
    return operation;
  }
}

export function meetingScope(config) {
  return [
    config.guildId,
    config.voiceChannelId,
    config.textChannelId,
    config.workingDirectory,
  ].join(":");
}
