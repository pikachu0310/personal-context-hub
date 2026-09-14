# IDO Engine

Self-hosted IDO Engine with a persistent main Codex model and supervised work Clients. Requires Node.js 24.x. Package names are provisional; no publication is performed by the repository build.

See the repository's `docs/ido-engine-client.md` for setup, supported platforms, protocol boundaries and live deployment checks.

```sh
ido-engine codex-login
ido-engine codex-status
ido-engine start
ido-engine status
ido-engine doctor
ido-engine stop
```

Engine and Client Codex homes/authentication are independent. Engine defaults to `<engine-data>/codex`; use the same `--codex-home` value for login, status and start to override it. The main model manages conversation and tasks in a restricted environment; Clients own actual repository work. `start --main-model <model>` overrides the default `gpt-5.6-sol` main model. OpenAI audio credentials are configured separately in Engine administration.

`start` defaults to `--conversation-mode text-speech`. `--conversation-mode live` selects Live for new meeting sessions while retaining independent speaker-attributed STT. Existing meetings resume their saved mode. `--conversation-mode legacy` retains the previous packages-based Responses path for comparison; it never imports `v0`. Discord can switch the current meeting with `/ido mode value:text-speech` or `/ido mode value:live`.

Administration is a bundled React/Mantine UI at `/admin`. The independent Dashboard plugin is also bundled and starts at `/dashboard/`; its failure does not stop administration or Client processing. Discord remains optional. Plugins communicate over versioned IPC and cannot import Engine internals.

Existing Engine data is upgraded transactionally to schema version 1 after creating `engine.before-v1.sqlite`. Messages and provider IDs are separated without replaying uncertain processing. Stop the previous Engine before upgrading; keep its data directory and backup. See `docs/packages-architecture.md` in the repository for rollback and extension contracts.

Normal conversation inputs queue while the main model is busy; urgent inputs use steering. Read-only investigations are independent Client tasks with negotiated restrictions. Coordinated modes build the minutes projection mechanically from message records. Raw PCM/WAV is not retained. Bot output records distinguish text delivery from unconfirmed audio playback.

Workspace operations `conversation/state`, `conversation/log` and `conversation/control` expose status and explicit recovery. Unknown model input and unknown text delivery are not automatically replayed. Restored source permission requires the same actor and plugin; a dedicated recovery UI is not included.

See `docs/conversation-modes.md`, `docs/work-port-contract.md` and `docs/main2-conversation-integration.md` in the repository for the current interfaces and migration mapping. Automated validation uses fake Codex/Live, players and local IPC. Real Live audio, microphone behavior and provider authentication require separate checks.
