# Discord Voice Codex hardening plan

Capability: `discord-voice-codex`

1. Treat commit `3b356d9` and the existing uncommitted tests as the implementation baseline.
2. Preserve the live Voice → STT → Codex → Text/TTS flow while tightening unattended execution boundaries.
3. Add failure-first tests for secret isolation, prompt boundaries, network-disabled Codex options, cancellable timeouts, bounded output, safe errors, and owner-only audio subscription.
4. Implement the smallest changes needed to satisfy those tests.
5. Run the repository verification suite, a mock-only local smoke, dependency audit, secret scan, and diff review.
6. Commit the complete reviewed delta without registering, inviting, starting, or sending through Discord.

Follow-up authorization was received and the real Codex SDK smoke was repeated through the isolated home. Live Discord login, Discord send, and audio API calls remain gated because no dedicated Bot credential or exact Guild, Voice channel, Text channel, owner user, and OpenAI audio API configuration is currently present.
