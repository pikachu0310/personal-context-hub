#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { Engine } from "./index.js";
import { Store } from "./store.js";
import { dataDirectory, openBrowser } from "../../common/src/platform.js";
import { control, lifetime, recover } from "../../common/src/lifecycle.js";
const args = process.argv.slice(2),
  command = args[0] ?? "start",
  directory = dataDirectory("engine");
const option = (name: string) => args[args.indexOf(name) + 1];
async function init() {
  const store = new Store(directory);
  try {
    if (store.users().length) return;
    let name: string, password: string;
    if (args.includes("--password-stdin")) {
      name = option("--name");
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      password = Buffer.concat(chunks).toString().trim();
    } else {
      if (!process.stdin.isTTY)
        throw new Error(
          "Initialize with: ido-engine init --name admin --password-stdin",
        );
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      name = await rl.question("管理者名: ");
      rl.close();
      process.stdout.write("パスワード（12文字以上）: ");
      password = await new Promise<string>((resolve) => {
        let value = "";
        process.stdin.setRawMode(true);
        process.stdin.resume();
        const read = (chunk: Buffer) => {
          for (const c of chunk.toString()) {
            if (c === "\r" || c === "\n") {
              process.stdin.off("data", read);
              process.stdin.setRawMode(false);
              process.stdin.pause();
              process.stdout.write("\n");
              resolve(value);
              return;
            }
            if (c === "\u0003") process.exit(130);
            if (c === "\u007f") value = value.slice(0, -1);
            else value += c;
          }
        };
        process.stdin.on("data", read);
      });
    }
    if (!name || name.length > 100) throw new Error("INVALID_ADMIN_NAME");
    store.createUser(name, password, "admin");
    process.stdout.write("管理者を作成しました。\n");
  } finally {
    store.close();
  }
}
try {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("IDO requires Node.js 24.x");
  if (command === "init") await init();
  else if (command === "status" || command === "stop")
    console.log(JSON.stringify(await control(directory, command)));
  else if (command === "doctor") {
    if (args.includes("--recover")) await recover(directory);
    console.log(
      JSON.stringify({
        node: process.version,
        storage: directory,
        ...(await control(directory, "status")),
      }),
    );
  } else if (command === "start") {
    await init();
    const engine = new Engine({
      directory,
      port: args.includes("--port") ? Number(option("--port")) : 4310,
      previewPort: args.includes("--preview-port")
        ? Number(option("--preview-port"))
        : 4311,
    });
    const close = await lifetime(directory, () => engine.close());
    try {
      await engine.listen();
    } catch (e) {
      await close();
      throw e;
    }
    console.log(`IDO Engine: ${engine.origin}`);
    if (!args.includes("--no-open")) openBrowser(engine.origin);
  } else if (command === "plugin-install") {
    const engine = new Engine({ directory });
    await engine.plugins.install(
      "0.2.0",
      args.includes("--tarball") ? option("--tarball") : undefined,
    );
    engine.store.close();
    console.log("Discord plugin installed");
  } else
    throw new Error(
      "Commands: init, start, stop, status, doctor, plugin-install",
    );
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
