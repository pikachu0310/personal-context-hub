#!/usr/bin/env node
import { control, lifetime, recover } from "@ido/common/runtime/lifecycle";
import { dataDirectory, openBrowser, run } from "@ido/common/runtime/platform";
import { Client } from "./bootstrap/client.js";
import { codexBinary } from "./execution/executor.js";
const args = process.argv.slice(2),
  command = args[0] ?? "start",
  directory = dataDirectory("client");
try {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("IDO requires Node.js 24.x");
  if (command === "status" || command === "stop")
    console.log(JSON.stringify(await control(directory, command)));
  else if (command === "doctor") {
    if (args.includes("--recover")) await recover(directory);
    console.log(
      JSON.stringify({
        node: process.version,
        codex: await run(codexBinary(), ["--version"]),
        ...(await control(directory, "status")),
      }),
    );
  } else if (command === "start") {
    const client = new Client(directory);
    const close = await lifetime(directory, () => client.close());
    try {
      await client.start(
        args.includes("--port")
          ? Number(args[args.indexOf("--port") + 1])
          : 4320,
      );
    } catch (e) {
      await close();
      throw e;
    }
    console.log(`IDO Client: ${client.origin}`);
    if (!args.includes("--no-open")) openBrowser(client.origin);
  } else throw new Error("Commands: start, stop, status, doctor");
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
