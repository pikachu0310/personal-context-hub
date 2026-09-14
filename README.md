# IDO

Self-hosted Engine, local Codex Clients, and an optional Discord plugin. Node.js 24 is required.

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

The Engine dashboard is at `http://127.0.0.1:4310`; the Client dashboard is at `http://127.0.0.1:4320`. Use separate `IDO_DATA_DIR` values to override their respective storage directories. Secrets default to owner-only `secrets.json` files in those directories. Runtime data is not moved by source-tree reorganization.

See [setup and architecture](docs/ido-engine-client.md) for administrator initialization, Discord installation, `/join` and `/leave`, Client pairing, single-host ngrok publishing, and preview restrictions.

## Current layout

- `packages/engine`: dashboard server, conversation processing, task allocation and preview relay.
- `packages/client`: local Codex app-server adapter, repositories, worktrees and execution.
- `packages/plugin-discord`: Bot, voice commands and Activity integration.
- `packages/common`: shared protocols, policy and local storage.
- `packages/dashboard`: React/Mantine UI bundled into Engine and Client distributions.
- `scripts`: current build, package, browser validation and repository coordination tools.
- `examples/ido-preview`: compatible preview application.

All current runtime source dependencies are inside `packages/`. The build checks this boundary. npm workspaces exclude the legacy archive.

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
