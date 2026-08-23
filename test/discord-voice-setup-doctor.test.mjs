import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  runDiscordVoiceSetupDoctor,
  VOICE_CODEX_DOCTOR_FAILED,
  VOICE_CODEX_DOCTOR_OK,
} from "../src/discord-voice-setup-doctor.mjs";

const validEnvironment = Object.freeze({
  PERSONAL_CONTEXT_VOICE_GUILD_ID: "11111111111111111",
  PERSONAL_CONTEXT_VOICE_CHANNEL_ID: "22222222222222222",
  PERSONAL_CONTEXT_VOICE_TEXT_CHANNEL_ID: "33333333333333333",
  PERSONAL_CONTEXT_VOICE_USER_ID: "44444444444444444",
  PERSONAL_CONTEXT_VOICE_WORKDIR: "/tmp/voice-workspace",
});

function checks() {
  return {
    runtime: "passed",
    publicConfig: "passed",
    mockVertical: "passed",
    codexIsolation: "passed",
  };
}

test("setup doctor passes the three credential-free gates", async () => {
  const calls = [];
  const report = await runDiscordVoiceSetupDoctor({
    env: validEnvironment,
    inspect: async (options) => {
      calls.push(["inspect", options.mode]);
      return { ready: true, issues: [] };
    },
    runMock: async () => {
      calls.push("mock");
      return { ok: true, marker: "VOICE_CODEX_MOCK_E2E_OK" };
    },
    runLocal: async () => {
      calls.push("local");
      return { ok: true, marker: "VOICE_CODEX_LOCAL_OK" };
    },
    nodeVersion: "24.18.0",
  });

  assert.equal(report.ready, true);
  assert.equal(report.marker, VOICE_CODEX_DOCTOR_OK);
  assert.equal(report.externalCalls, 0);
  assert.deepEqual(report.checks, checks());
  assert.deepEqual(calls, [["inspect", "offline"], "mock", "local"]);
  assert.deepEqual(report.issues, []);
});

test("setup doctor returns fixed issues when a local gate fails", async () => {
  const report = await runDiscordVoiceSetupDoctor({
    env: validEnvironment,
    inspect: async () => ({
      ready: false,
      issues: [
        {
          code: "CONFIG_INVALID",
          message: "raw secret child detail",
          action: "raw remediation detail",
          field: "PERSONAL_CONTEXT_VOICE_USER_ID",
        },
      ],
    }),
    runMock: async () => ({
      ok: false,
      marker: "VOICE_CODEX_MOCK_E2E_FAILED",
      detail: "secret child stderr must not escape",
    }),
    runLocal: async () => ({
      ok: true,
      marker: "VOICE_CODEX_LOCAL_OK",
    }),
    nodeVersion: "24.18.0",
  });

  assert.equal(report.ready, false);
  assert.equal(report.marker, VOICE_CODEX_DOCTOR_FAILED);
  assert.deepEqual(report.checks, {
    runtime: "passed",
    publicConfig: "failed",
    mockVertical: "failed",
    codexIsolation: "passed",
  });
  assert.deepEqual(
    report.issues.map(({ code }) => code),
    ["CONFIG_INVALID", "MOCK_SMOKE_FAILED"],
  );
  assert.doesNotMatch(
    JSON.stringify(report),
    /raw secret child detail|raw remediation detail|secret child stderr/,
  );
});

test("unsupported Node runtime skips child checks without raw details", async () => {
  const report = await runDiscordVoiceSetupDoctor({
    env: validEnvironment,
    inspect: async () => {
      throw new Error("must not inspect on unsupported runtime");
    },
    runMock: async () => {
      throw new Error("must not run mock");
    },
    runLocal: async () => {
      throw new Error("must not run local");
    },
    nodeVersion: "20.0.0",
  });

  assert.equal(report.ready, false);
  assert.deepEqual(report.checks, {
    runtime: "failed",
    publicConfig: "skipped",
    mockVertical: "skipped",
    codexIsolation: "skipped",
  });
  assert.deepEqual(
    report.issues.map(({ code }) => code),
    ["NODE_RUNTIME_UNSUPPORTED"],
  );
  assert.doesNotMatch(JSON.stringify(report), /must not/);
});

test("doctor CLI passes with public environment only", () => {
  const script = fileURLToPath(
    new URL("../scripts/discord-voice-setup-doctor.mjs", import.meta.url),
  );
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...validEnvironment,
      PERSONAL_CONTEXT_VOICE_WORKDIR: process.cwd(),
      OPENAI_API_KEY: "doctor-cli-secret-never-print",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.marker, VOICE_CODEX_DOCTOR_OK);
  assert.equal(report.ready, true);
  assert.equal(report.externalCalls, 0);
  assert.doesNotMatch(result.stdout, /doctor-cli-secret-never-print/);
});
