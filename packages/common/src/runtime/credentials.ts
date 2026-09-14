import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomic, hash, json, run, secret } from "./platform.js";

// Never send secret values through argv, stdout diagnostics or browser GETs.
export class Credentials {
  backend: "keychain" | "dpapi" | "secret-service" | "file";
  constructor(
    readonly directory: string,
    readonly service: string,
    backend?: Credentials["backend"],
  ) {
    // Normal Engine/Client startup uses the application-owned file on every OS.
    // Explicit backends remain available for legacy credential tooling.
    this.backend = backend ?? "file";
  }
  private key(name: string) {
    return hash(this.directory + ":" + name);
  }
  private async dpapi(action: "read" | "write", input: string) {
    const script = `$v=[Console]::In.ReadToEnd(); Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($v); $o=[Security.Cryptography.ProtectedData]::${action === "write" ? "Protect" : "Unprotect"}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($o))`;
    return run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { input },
    );
  }
  async set(name: string, value: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const key = this.key(name);
    if (this.backend === "keychain") {
      // security's interactive command input keeps the secret out of argv.
      const quote = (s: string) =>
        '"' +
        s
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/[\r\n]/g, "") +
        '"';
      const encoded = "base64:" + Buffer.from(value).toString("base64");
      try {
        await run("/usr/bin/security", ["-i"], {
          input: `add-generic-password -U -a ${quote(key)} -s ${quote(this.service)} -w ${quote(encoded)}\n`,
        });
        const saved = await run("/usr/bin/security", [
          "find-generic-password",
          "-a",
          key,
          "-s",
          this.service,
          "-w",
        ]);
        if (saved !== encoded) throw new Error("CREDENTIAL_WRITE_FAILED");
        return;
      } catch {
        this.backend = "file";
      }
    }
    if (this.backend === "secret-service") {
      try {
        await run(
          "secret-tool",
          ["store", "--label=IDO", "service", this.service, "key", key],
          { input: value },
        );
        return;
      } catch {
        this.backend = "file";
      }
    }
    const values = await json<Record<string, string>>(
      join(this.directory, "secrets.json"),
      {},
    );
    values[key] =
      this.backend === "dpapi"
        ? await this.dpapi("write", Buffer.from(value).toString("base64"))
        : value;
    await atomic(join(this.directory, "secrets.json"), values);
  }
  async get(name: string): Promise<string | undefined> {
    const key = this.key(name);
    if (this.backend === "keychain") {
      try {
        const value = await run("/usr/bin/security", [
          "find-generic-password",
          "-a",
          key,
          "-s",
          this.service,
          "-w",
        ]);
        return value.startsWith("base64:")
          ? Buffer.from(value.slice(7), "base64").toString()
          : value;
      } catch {
        /* headless fallback */
      }
    }
    if (this.backend === "secret-service") {
      try {
        const value = await run("secret-tool", [
          "lookup",
          "service",
          this.service,
          "key",
          key,
        ]);
        if (value) return value;
      } catch {
        /* headless fallback */
      }
    }
    const values = await json<Record<string, string>>(
      join(this.directory, "secrets.json"),
      {},
    );
    if (!values[key]) return undefined;
    return this.backend === "dpapi"
      ? Buffer.from(await this.dpapi("read", values[key]), "base64").toString()
      : values[key];
  }
  async withFile(name: string, use: (path: string) => Promise<void>) {
    const value = await this.get(name);
    if (!value) throw new Error("CREDENTIAL_REQUIRED");
    const path = join(this.directory, secret() + ".secret");
    await writeFile(path, value, { mode: 0o600 });
    await chmod(path, 0o600);
    try {
      await use(path);
    } finally {
      await rm(path, { force: true });
    }
  }
}
