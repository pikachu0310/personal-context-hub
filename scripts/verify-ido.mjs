import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { buildPackages } from "./build-ido.mjs";
import {
  isSelectedSource,
  selectedSuites,
  testBuilds,
} from "./ido-targets.mjs";

const mode = process.argv[2] ?? "verify";
if (!["verify", "check", "test"].includes(mode))
  throw new Error(`Unknown verification mode: ${mode}`);
const selected = selectedSuites(process.env.IDO_PACKAGES);
const fullBuild = process.env.IDO_FULL_BUILD === "true";
console.log(`IDO ${mode}: ${selected.join(", ") || "no affected packages"}`);
if (!selected.length && !fullBuild) process.exit(0);

// Module caching ensures common and common-ui are each built once per command.
if (selected.some((name) => name !== "tooling" && name !== "common"))
  await import("./build-common-ui.mjs");
else if (selected.includes("common")) await import("./build-common.mjs");

if (mode !== "test") {
  for (const config of ["tsconfig.ido.json", "tsconfig.ui.json"]) {
    const loaded = ts.readConfigFile(config, ts.sys.readFile);
    if (loaded.error)
      throw new Error(
        ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"),
      );
    const parsed = ts.parseJsonConfigFileContent(
      loaded.config,
      ts.sys,
      resolve("."),
    );
    const rootNames = parsed.fileNames.filter((path) =>
      isSelectedSource(path, resolve("."), selected),
    );
    const diagnostics = [...parsed.errors];
    if (rootNames.length)
      diagnostics.push(
        ...ts.getPreEmitDiagnostics(
          ts.createProgram({ rootNames, options: parsed.options }),
        ),
      );
    if (diagnostics.length) {
      console.error(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCurrentDirectory: () => process.cwd(),
          getCanonicalFileName: (name) => name,
          getNewLine: () => "\n",
        }),
      );
      process.exit(1);
    }
  }
}

if (mode !== "check") {
  const builds = testBuilds(selected, fullBuild);
  if (builds.length) await buildPackages(builds);
  const files = [];
  for (const name of selected) {
    const directory =
      name === "tooling" ? "scripts/test" : `packages/${name}/test`;
    let entries;
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    files.push(
      ...entries
        .filter((file) => /\.test\.(?:ts|mjs)$/.test(file))
        .sort()
        .map((file) => `${directory}/${file}`),
    );
  }
  if (files.length)
    execFileSync(process.execPath, ["--import", "tsx", "--test", ...files], {
      stdio: "inherit",
    });
}
