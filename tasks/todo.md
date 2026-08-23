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
- [x] `npm run verify`, local smoke, and isolated SDK smoke pass
- [x] Secret scan, diff review, and follow-up commits complete
