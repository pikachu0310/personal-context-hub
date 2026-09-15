# IDO

Self-hosted Engine with API-based conversation processing, local Codex Clients for delegated work, a bundled Dashboard plugin, and an optional Discord plugin. Node.js 24 is required. The Engine supports both text with STT/TTS and GPT-Live with independent speaker-attributed STT.

Meetings keep speaker-attributed raw statements and automatically updated topic minutes with source references. Meeting Codex tasks can search this context, receive a teammate's follow-up in the same task, and stop on a clearly targeted request. Useful small investigations and prototypes can start proactively with duplicate, concurrency and cooldown limits. See [meeting behavior and evaluation](docs/conversation-modes.md).

Generated standalone HTML prototypes can be opened directly in a task. Try the result, request a change from the preview, and open the updated version in the same conversation. See [the meeting-to-prototype exhibition rehearsal](docs/meeting-demo.md) for a concrete VR locomotion comparison and a short live-demo sequence.

## Local development

```sh
npm ci
npm run build
npm test
```

Start the Engine in one terminal, then configure its OpenAI API key in administration:

```sh
node packages/engine/dist/cli.js start
```

Start a Client in another terminal:

```sh
node packages/client/dist/cli.js start
```

For a native Windows or macOS Client window, run `npm run build:desktop` then `npm run start:desktop`. Distributable IDO Agent installers bundle the runtime and Codex. Discord's `/ido connect` guides participants through download, launch and pairing. See [desktop app and issue forum setup](docs/main2-desktop-forum.md) for platform builds, download links and task-thread synchronization.

Engine administration is at `http://127.0.0.1:4310/admin`, the operational Dashboard at `http://127.0.0.1:4310/dashboard/`; the Client dashboard is at `http://127.0.0.1:4320`. Use separate `IDO_DATA_DIR` values to override their respective storage directories. Secrets default to owner-only `secrets.json` files in those directories. Runtime data is not moved by source-tree reorganization.

The Engine uses OpenAI API requests for conversation and task coordination, with the same administration API key used for audio. It does not install or run Codex. Clients own repository access, execution and Codex authentication. `start --conversation-mode live` selects Live as the default for new meeting sessions; `/ido mode value:live` and `/ido mode value:text-speech` switch an existing meeting. See [conversation modes](docs/conversation-modes.md) for setup, interfaces and recovery.

See [setup and architecture](docs/ido-engine-client.md) for administrator initialization, Discord installation, `/join` and `/leave`, Client pairing, single-host ngrok publishing, and preview restrictions.

## Current layout

- `packages/engine`: message storage, Responses API coordinator, conversation/task processing, generic plugin host, Client supervision, and bundled React/Mantine administration UI.
- `packages/client`: local Codex app-server adapter, repositories, worktrees and execution.
- `packages/desktop`: Electron window, platform packaging and connection links for the current Client.
- `packages/plugin-discord`: Bot, voice commands and Activity integration.
- `packages/plugin-dashboard`: independent Dashboard process, compatibility API and React/Mantine administration UI. See [Dashboard guide](docs/ido-dashboard.md).
- `packages/common`: compiled public communication contracts and low-level runtime utilities, imported through `@ido/common/contracts/...` and `@ido/common/runtime/...`.
- `packages/common-ui`: compiled React/Mantine components and business views, imported through `@ido/common-ui`; receives data/actions from each owner.
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

`npm run verify:ido` builds shared packages once, checks types, builds the required
runtimes, and runs tests. `npm test` also builds its prerequisites, so it works
after a clean checkout. Set `IDO_PACKAGES` to a JSON array to select suites, for
example `IDO_PACKAGES='["client"]' npm test` in Bash. Available suites are
`common`, `common-ui`, `engine`, `client`, `plugin-discord`, `plugin-dashboard`
and `tooling`; an unset value runs all of them. This local selection is explicit;
CI additionally selects consumers and integration tests from changed paths.

CI uses [dorny/paths-filter](https://github.com/dorny/paths-filter) with
[the package filters](.github/filters.yml). Documentation and `v0/` changes skip
runtime checks. Test-only changes run their owning suite; shared source changes
also run consumers, and Client/Discord/Dashboard source changes include Engine
integration tests. Build configuration and dependency changes run all suites.
Runtime or packaging changes retain tarball installation checks on Linux,
macOS and Windows. The shared browser smoke runs once on Linux when its inputs
change. Manual workflow dispatch runs everything. `CI Success` aggregates both
executed and intentionally skipped jobs into one stable check.

Development-tool tests live in `scripts/test/`; shared Codex protocol and
credential tests live in `packages/common/test/`. `npm run audit` runs dependency
auditing separately from repeated CI installations.

## Legacy archive

`v0/` contains the previous application, Electron client, MCP integrations, UI, tests, deployment tools and their documentation. It has its own package manifest and lockfile. The current runtime, build, tests and CI do not import or execute it. To inspect or run the archived system, explicitly change into that directory and follow its README; its commands are relative to that directory. Existing private configuration is not copied into the archive.
