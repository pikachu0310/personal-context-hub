import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseEnv, promisify } from "node:util";
import {
  inspectAgentHost,
  agentHostReportText,
} from "../src/discord-agent-host-inspection.mjs";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const window = args.length === 1 && args[0] === "--window";
async function powershell(script, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-STA",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 120_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin.end(input ?? "");
  });
}

try {
  if (!window && !(args.length === 2 && args[0] === "--env-file"))
    throw new Error("arguments");
  let path = args[1];
  if (window) {
    if (process.platform !== "win32") throw new Error("platform");
    path = (
      await powershell(
        "Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $dialog = New-Object System.Windows.Forms.OpenFileDialog; $dialog.Title = 'Select the Bot runtime .env file'; $dialog.Filter = 'Bot configuration (.env*)|.env*|All files (*.*)|*.*'; if ($dialog.ShowDialog() -eq 'OK') { [Console]::Write($dialog.FileName) }",
      )
    ).trim();
    if (!path) process.exit(0);
  }
  const source = await readFile(path, "utf8");
  if (Buffer.byteLength(source) > 256 * 1024) throw new Error("size");
  const report = inspectAgentHost(parseEnv(source));
  if (window) {
    await powershell(
      "Add-Type -AssemblyName System.Windows.Forms; [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); $report = [Console]::In.ReadToEnd(); [System.Windows.Forms.MessageBox]::Show($report, 'Agent host check', 'OK', 'Information') | Out-Null",
      agentHostReportText(report),
    );
  } else console.log(JSON.stringify(report, null, 2));
  if (!report.localConfigPassed || !report.publicEndpointConfigured)
    process.exitCode = 1;
} catch {
  const message =
    "Could not inspect the configuration. Use Node.js 22 or later and select the Bot runtime .env file. No settings were changed.";
  if (window)
    await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${message}', 'Agent host check', 'OK', 'Error') | Out-Null`,
          "utf16le",
        ).toString("base64"),
      ],
      { windowsHide: true },
    ).catch(() => undefined);
  else console.error(message);
  process.exitCode = 1;
}
