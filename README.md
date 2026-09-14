# IDO

Self-hosted Engine, local Codex Clients, a bundled Dashboard plugin, and an optional Discord plugin. Node.js 24 is required.

## Local development

```sh
npm ci
npm run build
npm test
```

Initialize and start the Engine in one terminal:

```sh
node packages/engine/dist/cli.js start
```

Start a Client in another terminal:

```sh
node packages/client/dist/cli.js start
```

Engine administration is at `http://127.0.0.1:4310/admin`, the business Dashboard at `http://127.0.0.1:4310/dashboard/`; the Client dashboard is at `http://127.0.0.1:4320`. Use separate `IDO_DATA_DIR` values to override their respective storage directories. Secrets default to owner-only `secrets.json` files in those directories. Runtime data is not moved by source-tree reorganization.

See [setup and architecture](docs/ido-engine-client.md) for administrator initialization, Discord installation, `/join` and `/leave`, Client pairing, single-host ngrok publishing, and preview restrictions.

## Current layout

- `packages/engine`: message storage, conversation/task processing, generic plugin host, Client connections, and bundled React/Mantine administration UI.
- `packages/client`: local Codex app-server adapter, repositories, worktrees and execution.
- `packages/plugin-discord`: Bot, voice commands and Activity integration.
- `packages/plugin-dashboard`: independent Dashboard process, business HTTP API and React/Mantine web UI.
- `packages/common`: public communication contracts and low-level runtime utilities.
- `packages/ui`: Mantine components and business views receiving data/actions from their owner.
- `scripts`: current build, package, browser validation and repository coordination tools.
- `examples/ido-preview`: compatible preview application.

All current runtime source dependencies are inside `packages/`. The build checks package and layer dependencies. See [package architecture](docs/packages-architecture.md) for contracts and data migration. npm workspaces exclude the legacy archive.

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
