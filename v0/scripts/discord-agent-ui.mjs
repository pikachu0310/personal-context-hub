#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createAgentUi } from "../src/discord-agent-ui.mjs";
import { AGENT_UI_PORT } from "../src/discord-agent-onboarding.mjs";

const ui = await createAgentUi({ port: AGENT_UI_PORT }).catch((error) => {
  const message =
    error.code === "EADDRINUSE"
      ? "The legacy browser UI is already running, or port 17879 is in use. Return to its existing browser tab. For the desktop app, open IDO Agent from the Windows Start menu."
      : "Could not start the agent connection app. Check the local configuration and try again.";
  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${message}', 'Agent setup', 'OK', 'Error') | Out-Null`,
          "utf16le",
        ).toString("base64"),
      ],
      { windowsHide: true, stdio: "ignore" },
    );
  } else console.error(message);
  process.exit(1);
});
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
