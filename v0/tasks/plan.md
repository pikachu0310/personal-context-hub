# Discord Voice Codex hardening plan

Capability: `discord-voice-codex`

1. Treat commit `3b356d9` and the existing uncommitted tests as the implementation baseline.
2. Preserve the live Voice → STT → Codex → Text/TTS flow while tightening unattended execution boundaries.
3. Add failure-first tests for secret isolation, prompt boundaries, network-disabled Codex options, cancellable timeouts, bounded output, safe errors, and owner-only audio subscription.
4. Implement the smallest changes needed to satisfy those tests.
5. Run the repository verification suite, a mock-only local smoke, dependency audit, secret scan, and diff review.
6. Commit the complete reviewed delta without registering, inviting, starting, or sending through Discord.

Follow-up authorization was received and the real Codex SDK smoke was repeated through the isolated home. Live Discord login, Discord send, and audio API calls remain gated because no dedicated Bot credential or exact Guild, Voice channel, Text channel, owner user, and OpenAI audio API configuration is currently present.

## Cycle 3: credential-free verification

1. Define credential-free preflight, a fully mocked audio vertical, and stable failure guidance as acceptance criteria.
2. Extract configuration diagnostics into a dependency-injected module with explicit offline and full modes.
3. Drive synthetic owner PCM through the real Discord receive/session orchestration while mocking every external boundary.
4. Verify that diagnostic output and mock evidence contain no credentials, raw dependency errors, or external calls.
5. Run the complete repository verification, offline preflight, mock smoke, local smoke, audit, secret scan, and diff review.
6. Commit the verified changes in logical units without pushing or contacting Discord.

## Cycle 4: setup doctor and evidence record

1. Add acceptance criteria for an offline aggregate doctor, a staged preflight checklist, and a public-safe verification record.
2. Implement a dependency-injected doctor that never loads `.env`, Bot credentials, OpenAI keys, or Codex auth in offline mode.
3. Run the existing offline diagnostic, mock vertical, and local isolation smoke as bounded child checks with stable summaries.
4. Document the exact human-only steps for credential setup and one-time Discord verification; do not perform them in this cycle.
5. Record commit IDs, command outcomes, coverage/audit status, and blocked external checks in a repository verification record.
6. Run doctor, full verification, all local smokes, secret scan, diff review, and commit the reviewed delta without push.
