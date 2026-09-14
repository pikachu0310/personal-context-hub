# IDO

Self-hosted Engine with a persistent conversation model, local Codex Clients for delegated work, a bundled Dashboard plugin, and an optional Discord plugin. Node.js 24 is required. The Engine supports both text with STT/TTS and GPT-Live with independent speaker-attributed STT.

## Local development

```sh
npm ci
npm run build
npm test
```

Authenticate the Engine's main model and start it in one terminal:

```sh
node packages/engine/dist/cli.js codex-login
node packages/engine/dist/cli.js codex-status
node packages/engine/dist/cli.js start
```

Start a Client in another terminal:

```sh
node packages/client/dist/cli.js start
```

Engine administration is at `http://127.0.0.1:4310/admin`, the business Dashboard at `http://127.0.0.1:4310/dashboard/`; the Client dashboard is at `http://127.0.0.1:4320`. Use separate `IDO_DATA_DIR` values to override their respective storage directories. Secrets default to owner-only `secrets.json` files in those directories. Runtime data is not moved by source-tree reorganization.

The Engine and each Client have independent Codex homes and authentication. The Engine's main model manages conversation and delegates work; Clients own repository access and execution. OpenAI audio credentials are configured separately in Engine administration. `start --conversation-mode live` selects Live as the default for new meeting sessions; `/ido mode value:live` and `/ido mode value:text-speech` switch an existing meeting. See [conversation modes](docs/conversation-modes.md) for setup, interfaces and recovery.

See [setup and architecture](docs/ido-engine-client.md) for administrator initialization, Discord installation, `/join` and `/leave`, Client pairing, single-host ngrok publishing, and preview restrictions.

## Current layout

- `packages/engine`: message storage, persistent main Codex coordinator, conversation/task processing, generic plugin host, Client supervision, and bundled React/Mantine administration UI.
- `packages/client`: local Codex app-server adapter, repositories, worktrees and execution.
- `packages/plugin-discord`: Bot, voice commands and Activity integration.
- `packages/plugin-dashboard`: independent Dashboard process, business HTTP API and React/Mantine web UI.
- `packages/common`: public communication contracts and low-level runtime utilities.
- `packages/ui`: Mantine components and business views receiving data/actions from their owner.
- `scripts`: current build, package, browser validation and repository coordination tools.
- `examples/ido-preview`: compatible preview application.

All current runtime source dependencies are inside `packages/`. The build checks package and layer dependencies. See [package architecture](docs/packages-architecture.md) for contracts and data migration. npm workspaces exclude the legacy archive.

[Integration mapping](docs/main2-conversation-integration.md) records which earlier conversation components were reused, adapted or replaced. [WorkPort](docs/work-port-contract.md) defines the boundary between the main model and delegated work.

## Verification and packaging

```sh
npm run verify
npm run smoke:ido
npm run pack:ido
npm run smoke:ido:pack
```

Tarballs are written to `.ido-build/tarballs`. `build:ido`, `check:ido`, `test:ido`, and `verify:ido` remain available. These commands do not publish packages or start a live Discord Bot.

## Legacy archive

`v0/` contains the previous application, Electron client, MCP integrations, UI, tests, deployment tools and their documentation. It has its own package manifest and lockfile. The current runtime, build, tests and CI do not import or execute it. To inspect or run the archived system, explicitly change into that directory and follow its README; its commands are relative to that directory. Existing private configuration is not copied into the archive.
