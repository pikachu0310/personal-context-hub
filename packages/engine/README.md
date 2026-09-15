# IDO Engine

Self-hosted IDO Engine with an OpenAI Responses API coordinator and supervised work Clients. Requires Node.js 24.x. Package names are provisional; no publication is performed by the repository build.

See the repository's `docs/ido-engine-client.md` for setup, supported platforms, protocol boundaries and live deployment checks.

```sh
ido-engine start
ido-engine status
ido-engine doctor
ido-engine stop
```

Configure the OpenAI API key in Engine administration for conversation, STT, TTS and Live. Engine does not install or run Codex and needs no Codex login or home. Clients use their own Codex authentication for repository work. `start --main-model <model>` overrides the default `gpt-4.1-mini` API model. Requests include bounded local conversation history, use structured JSON output and `store: false`, and expose no tools.

`start` defaults to `--conversation-mode text-speech`. `--conversation-mode live` selects Live for new meeting sessions while retaining independent speaker-attributed STT. Existing meetings resume their saved mode. `--conversation-mode legacy` retains the previous packages-based Responses path for comparison; it never imports `v0`. Discord can switch the current meeting with `/ido mode value:text-speech` or `/ido mode value:live`.

The Engine listens on `0.0.0.0:4310` by default. Open `http://<server-address>:4310/admin` from another machine; HTTP and WebSocket connections do not require a local HTTPS proxy. Engine URLs accept HTTP and HTTPS. Login, CSRF, browser origin checks and device authentication apply to every address.

Administration is a bundled React/Mantine UI at `/admin`. The independent Dashboard plugin is also bundled and starts at `/dashboard/`; its failure does not stop administration or Client processing. Discord remains optional. Plugins communicate over versioned IPC and cannot import Engine internals.

Administration setup proceeds through OpenAI, public URL (only for external access), and optional plugin connections. Discord is installed before its configuration fields are shown. Credential fields use ordinary text inputs; saved values display a read-only mask with an explicit change action. Only actual account passwords use password inputs. The admin state API exposes credential presence and the Engine storage path, never saved credential values. By default, credentials are stored unencrypted in `<engine-data>/secrets.json`, not browser storage; unchanged masked fields are omitted from save requests.

Existing Engine data is upgraded transactionally to schema version 1 after creating `engine.before-v1.sqlite`. Messages and provider IDs are separated without replaying uncertain processing. Stop the previous Engine before upgrading; keep its data directory and backup. See `docs/packages-architecture.md` in the repository for rollback and extension contracts.

Normal conversation inputs queue while the main model is busy; urgent inputs queue for the next API request. Read-only investigations are independent Client tasks with negotiated restrictions. Coordinated modes build the minutes projection mechanically from message records. Raw PCM/WAV is not retained. Bot output records distinguish text delivery from unconfirmed audio playback.

Workspace operations `conversation/state`, `conversation/log` and `conversation/control` expose status and explicit recovery. Unknown model input and unknown text delivery are not automatically replayed. Restored source permission requires the same actor and plugin; a dedicated recovery UI is not included.

See `docs/conversation-modes.md`, `docs/work-port-contract.md` and `docs/main2-conversation-integration.md` in the repository for the current interfaces and migration mapping. Automated validation uses mocked Responses API/Live, players and local IPC. Real Live audio, microphone behavior and provider authentication require separate checks.
