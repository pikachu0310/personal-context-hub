import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import yaml from "js-yaml";
import picomatch from "picomatch";
import {
  isSelectedSource,
  selectedSuites,
  suites,
  testBuilds,
  runtimePackages,
} from "../ido-targets.mjs";

test("typecheck selection supports TypeScript's normalized Windows paths", () => {
  assert.equal(
    isSelectedSource("C:/repo/packages/client/src/index.ts", "C:\\repo", [
      "client",
    ]),
    true,
  );
  assert.equal(
    isSelectedSource("C:\\repo\\packages\\client\\src\\index.ts", "C:/repo", [
      "client",
    ]),
    true,
  );
  assert.equal(
    isSelectedSource("/repo/packages/client/src/index.ts", "/repo", ["client"]),
    true,
  );
  assert.equal(
    isSelectedSource("/repo/packages/client-other/src/index.ts", "/repo", [
      "client",
    ]),
    false,
  );
  assert.equal(
    isSelectedSource("/repo/packages/engine/src/index.ts", "/repo", ["client"]),
    false,
  );
});

// Use the same YAML and glob semantics as dorny/paths-filter (including dotfiles).
const filters = yaml.load(
  readFileSync(new URL("../../.github/filters.yml", import.meta.url), "utf8"),
);
function affected(...paths) {
  return Object.entries(filters)
    .filter(([, rules]) =>
      paths.some(picomatch(rules.flat(Infinity), { dot: true })),
    )
    .map(([name]) => name);
}

test("docs and legacy edits skip CI, test edits select only their owner", () => {
  assert.deepEqual(
    affected("docs/setup.md", "README.md", "AGENTS.md", "v0/package.json"),
    [],
  );
  assert.deepEqual(affected("packages/client/test/work.test.ts"), ["client"]);
  assert.deepEqual(affected("packages/desktop/test/security.test.ts"), [
    "desktop",
  ]);
  assert.deepEqual(affected("packages/common/test/app-server.test.mjs"), [
    "common",
  ]);
  assert.deepEqual(affected("scripts/read-github-coordination.mjs"), [
    "tooling",
  ]);
  assert.deepEqual(affected("packages/client/README.md"), ["pack"]);
});

test("runtime changes include consumers and integration tests", () => {
  assert.deepEqual(affected("packages/desktop/src/security.ts"), [
    "desktop",
    "pack",
  ]);
  assert.deepEqual(affected("packages/client/src/execution/run.ts"), [
    "engine",
    "client",
    "desktop",
    "pack",
    "browser",
  ]);
  assert.deepEqual(affected("packages/plugin-discord/src/input/normalize.ts"), [
    "engine",
    "plugin-discord",
    "pack",
  ]);
  assert.deepEqual(
    affected("packages/plugin-dashboard/src/runtime/dashboard.ts"),
    ["engine", "plugin-dashboard", "pack", "browser"],
  );
  assert.deepEqual(affected("packages/common-ui/src/style.css"), [
    "common-ui",
    ...runtimePackages,
    "desktop",
    "pack",
    "browser",
  ]);
  assert.deepEqual(affected("packages/common/src/runtime/rpc.ts"), [
    ...suites.filter((name) => name !== "tooling"),
    "pack",
    "browser",
  ]);
});

test("build configuration and dependencies invalidate all suites", () => {
  for (const path of [
    "package-lock.json",
    "package.json",
    ".npmrc",
    "tsconfig.ui.json",
    "packages/engine/package.json",
    "packages/common/tsconfig.build.json",
    "scripts/build-common.mjs",
    "scripts/verify-ido.mjs",
    ".github/filters.yml",
    ".github/workflows/ci.yml",
  ])
    assert.deepEqual(affected(path), [...suites, "pack", "browser"], path);
});

test("smoke changes run the relevant smoke and build its prerequisites", () => {
  assert.deepEqual(affected("scripts/ido-pack-smoke.mjs"), ["tooling", "pack"]);
  assert.deepEqual(affected("scripts/ido-preview-browser-smoke.mjs"), [
    "tooling",
    "browser",
  ]);
  assert.deepEqual(affected("examples/ido-preview/server.mjs"), ["browser"]);
  assert.deepEqual(testBuilds([], true), runtimePackages);
  assert.deepEqual(testBuilds(["tooling"]), []);
  assert.deepEqual(testBuilds(["common"]), []);
  assert.deepEqual(testBuilds(["client"]), ["client"]);
  assert.deepEqual(testBuilds(["engine"]), [
    "engine",
    "plugin-dashboard",
    "plugin-discord",
  ]);
});

test("suite selection defaults to everything and rejects invalid CI inputs", () => {
  assert.deepEqual(selectedSuites(), suites);
  assert.deepEqual(selectedSuites("[]"), []);
  assert.deepEqual(selectedSuites('["client","client"]'), ["client"]);
  for (const value of ['["../v0"]', '"client"', "null", "{}", '["unknown"]'])
    assert.throws(() => selectedSuites(value), /IDO_PACKAGES/);
});
