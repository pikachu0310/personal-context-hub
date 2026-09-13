#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createAgentUi } from "../src/discord-agent-ui.mjs";

const ui = await createAgentUi();
const launch =
  process.platform === "win32"
    ? [
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(`Start-Process '${ui.url}'`, "utf16le").toString(
            "base64",
          ),
        ],
      ]
    : process.platform === "darwin"
      ? ["open", [ui.url]]
      : ["xdg-open", [ui.url]];
const browser = spawn(...launch, { stdio: "ignore", windowsHide: true });
browser.once("error", () => {
  console.error(
    "Could not open the browser. Start the agent app in a desktop session.",
  );
  void ui.close();
});
const shutdown = async () => {
  await ui.close();
  process.exitCode = 0;
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
