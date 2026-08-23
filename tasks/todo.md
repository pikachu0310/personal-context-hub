# Discord Voice Codex acceptance checklist

- [x] Existing implementation, specification, branch, and commit inspected
- [x] Existing dirty work preserved and baseline `npm run verify` completed
- [x] Codex child environment changed from denylist to allowlist
- [x] Codex network and web search disabled for unattended voice turns
- [x] Transcript embedded as explicitly untrusted JSON input
- [x] STT uses current `gpt-transcribe` context and language hints
- [x] Stage timeout aborts cancellable work and cannot block later turns
- [x] Internal error details do not reach Discord or structured logs
- [x] Transcript, Codex text, and TTS excerpt have hard bounds
- [x] Owner allowlist behavior covered at the voice subscription boundary
- [x] Direct imports are declared as direct dependencies
- [x] Isolated Codex home uses only an auth symlink and empty config
- [x] SIGINT/SIGTERM stop cancels the active stage and drops queued turns
- [x] Startup and normal shutdown contain synchronous and asynchronous cleanup failures
- [x] Client, Voice connection, stream, decoder, and player errors cannot crash the service
- [x] Oversized, malformed, and non-buffer audio frames are discarded once with fixed guidance
- [x] Discord and TTS text bounds preserve Unicode surrogate pairs
- [x] Installed Opus decoder and Discord Voice encryption/DAVE dependencies pass runtime inspection
- [x] Voice start, full inspection, and SDK smoke scripts load the ignored `.env` when present
- [x] `npm run verify`, local smoke, and isolated SDK smoke pass
- [x] Secret scan, diff review, and follow-up commits complete

## Cycle 3

- [x] Credential-free offline diagnostic implemented and tested
- [x] Diagnostic failures use stable codes and fixed remediation without raw errors
- [x] Synthetic PCM mock vertical covers receive through playback with zero external calls
- [x] Failure guide and operator command order documented
- [x] Full verification, offline smoke, mock smoke, local smoke, audit, and secret scan pass
- [x] Reviewed changes committed in logical units without push or Discord access

## Cycle 4

- [ ] Setup doctor aggregates offline config, mock vertical, and local isolation checks
- [ ] Doctor output and exit status contain no raw errors or credential values
- [ ] Preflight checklist separates local gates, credential setup, and one-time Discord verification
- [ ] Verification record fixes commands, commits, results, and unperformed external actions
- [ ] Full verification, doctor, smokes, secret scan, diff review, and commit pass
