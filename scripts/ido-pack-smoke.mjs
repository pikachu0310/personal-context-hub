import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const artifacts = JSON.parse(
  await readFile(".ido-build/packages.json", "utf8"),
);
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "ido-npm-install-")),
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const processes = [];
function cli(path, args, env, input) {
  return execFileSync(process.execPath, [path, ...args], {
    env,
    input,
    encoding: "utf8",
    timeout: 180000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
try {
  for (const name of ["engine", "client"]) {
    const root = join(directory, name),
      env = {
        ...process.env,
        IDO_DATA_DIR: join(root, "data"),
        IDO_CREDENTIAL_BACKEND: "file",
      };
    execFileSync(
      npm,
      [
        "install",
        "--prefix",
        root,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        artifacts.find((a) => a.name === `@ido/${name}`).path,
      ],
      {
        encoding: "utf8",
        timeout: 180000,
        shell: process.platform === "win32",
      },
    );
    const path = join(root, "node_modules", "@ido", name, "dist", "cli.js");
    if (name === "engine")
      cli(
        path,
        ["init", "--name", "smoke", "--password-stdin"],
        env,
        "tarball-test-password\n",
      );
    const child = spawn(
      process.execPath,
      [
        path,
        "start",
        "--port",
        "0",
        ...(name === "engine" ? ["--preview-port", "0"] : []),
        "--no-open",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    processes.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    let running = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((r) => setTimeout(r, 100));
      if (child.exitCode !== null)
        throw new Error(`Installed ${name} exited: ${stderr}`);
      try {
        running = JSON.parse(cli(path, ["status"], env)).running;
      } catch {
        /* The control listener may not be ready yet. */
      }
      if (running && /IDO (?:Engine|Client): http/.test(output)) break;
    }
    assert.equal(running, true);
    assert.equal(JSON.parse(cli(path, ["status"], env)).running, true);
    const origin = output.match(/IDO (?:Engine|Client): (http:\/\/\S+)/)?.[1];
    assert.ok(origin);
    assert.equal((await fetch(origin + "/health")).status, 200);
    assert.match(await (await fetch(origin)).text(), /id="root"/);
    const doctor = JSON.parse(cli(path, ["doctor"], env));
    assert.equal(doctor.running, true);
    if (name === "client") assert.match(doctor.codex, /codex/i);
    if (name === "engine") {
      const dependencies = JSON.parse(
        execFileSync(npm, ["ls", "--prefix", root, "--all", "--json"], {
          encoding: "utf8",
          shell: process.platform === "win32",
        }),
      );
      assert.ok(!JSON.stringify(dependencies).includes("@openai/codex"));
      assert.ok(!JSON.stringify(dependencies).includes("discord.js"));
      cli(
        path,
        [
          "plugin-install",
          "--tarball",
          artifacts.find((a) => a.name === "@ido/plugin-discord").path,
        ],
        env,
      );
    }
    cli(path, ["stop"], env);
    await new Promise((resolve) =>
      child.exitCode !== null ? resolve() : child.once("exit", resolve),
    );
    console.log(`Installed tarball smoke passed: @ido/${name}`);
  }
} finally {
  for (const child of processes) if (child.exitCode === null) child.kill();
  await rm(directory, { recursive: true, force: true });
}
