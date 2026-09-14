# Package architecture

Engine owns business state and decisions. Plugins own input/output integrations and communicate over versioned IPC; they do not import Engine implementation. Dashboard is a standard bundled plugin, not the administration server. Codex runs only on Client.

| Package            | Responsibilities and entry                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine`           | Composition in `bootstrap`; domain/ports, input, messages, processing, clients, output and management; SQLite/OpenAI/HTTP/WS/plugin adapters; React/Mantine administration at `/admin` |
| `client`           | Bootstrap, Engine connection/pairing, execution, approvals, Codex App Server, artifacts, preview and storage; its own React/Mantine UI at local port 4320                              |
| `plugin-dashboard` | Child runtime, business API, React/Mantine pages at `/dashboard/`                                                                                                                      |
| `plugin-discord`   | Child runtime, Discord normalization/policy, commands, delivery/publications, OAuth and Activity at `/plugins/discord/activity`                                                        |
| `ui`               | Shared presentation components and meeting/project/task/artifact views; data and actions are injected, no authentication or HTTP                                                       |
| `common`           | `contracts` for Client/Plugin messages and `runtime` for low-level utilities; no provider manifests or policy                                                                          |

Concrete adapters depend on use cases and domain/ports. `bootstrap/engine.ts` wires instances without a DI framework. SQLite persists records and transactions; task state transitions and allocation are implemented by `processing/tasks` and `clients`. `index` exports the runtime; `main.tsx` only mounts a UI.

## Plugin contract

`common/src/contracts/plugins.ts` defines protocol **2**, manifests, normalized conversation input, replies and business events. `common/src/runtime/rpc.ts` implements request/reply IDs, errors and bounded deadlines. Client protocol remains version 1. A protocol/manifest identity mismatch rejects launch and terminates the child.

Plugin lifecycle operations are `inspect`, `validate`, `start`, `configure`, `event` and `output`; stopping terminates the child and closes pending RPC calls. A plugin's `start` may return a loopback HTTP port. Its manifest declares a unique base path and explicit public paths. `/` is an exact public path; a non-root trailing slash denotes a prefix. Private requests require an Engine session and mutation CSRF checks before proxying. The proxy strips browser cookies and untrusted identity headers and injects an opaque context credential. Business operations resolve that context against current Engine membership and permissions again. Provider-supplied roles are never adopted.

Plugin-to-Engine operations include `input`, workspace `state`, `projects`, `meetings`, `messages`, `tasks`, `task/control`, `artifact`, `preview`, `identity.me`, `identity.link`, `identity.session`, and namespaced `storage.get`/`storage.put`. Member contexts are plugin/generation/session scoped. Activity credentials have a restricted operation set. Plugins that accept external speakers send their provider subject; Engine resolves it to a linked member or a conversation-only participant. The latter cannot log in or register Clients. Provider policy, OAuth validation and SDK use belong to the provider plugin.

The Engine catalog supplies package identity and the launch path. To add an input/output plugin, implement the public contract and register a catalog entry in bootstrap (or supply `EngineOptions.pluginCatalog` for an embedding/test). Conversation and persistence implementations do not change. A third synthetic plugin in `engine/test/plugins.test.ts` exercises this boundary without importing Engine code. Plugin code is trusted local code running with the OS user's permissions, not a security sandbox.

Generations change on start/stop; revisions change on configuration and voice invalidation. Pending input, replies and context credentials are fenced against those values and current roles. Discord additionally fences queued playback against its speech epoch. Business events go to running plugins subscribed through their meeting binding; an unbound Dashboard observes all meetings. Dashboard polls fresh snapshots, including after restart, so notifications are not its state authority. Discord card IDs reside under `plugin:discord`, separate from meetings.

## Message processing and migration

Text and audio use the same input router. The input ID is namespaced by plugin and durably accepted before asynchronous work. Audio is validated/transcribed, text is normalized, and explicit commands, immediate replies, or minutes processing are selected. Immediate replies/TTS and minutes run independently. Minutes updates serialize per meeting and merge changes into the latest record; task extraction uses Engine identities and permissions. Explicit task creation suppresses task extraction for that input. Ambiguous inputs are not retried automatically.

Messages live in separate SQLite records with transcription, reply, minutes and delivery states, including skipped, pending, running, failed and interrupted. Meeting responses include a projected message list for consumers, but the stored meeting contains no message array. Error IDs reference redacted Engine diagnostics. Raw audio is not retained.

Opening a version-0 Engine database creates `engine.before-v1.sqlite` using SQLite `VACUUM INTO` (including committed WAL contents) before a transactional version-1 migration. It separates existing messages, namespaces input/external identity IDs, moves provider publication IDs, and preserves current configuration records. Backups use owner-only permissions on POSIX. Existing migrated backups are not overwritten. Unsupported future versions fail closed. On startup, uncertain pending processing becomes interrupted and is never automatically replayed. Do not run old and new Engine versions concurrently against one data directory. To roll back, stop Engine, retain the migrated database separately, and restore the backup with SQLite WAL/SHM files removed while no process has it open.

Client journals, worktrees, credentials and dedicated Codex home retain their existing paths and recovery guarantees. No legacy `v0` application migration, PR #28 persistent/Live model, or Electron migration is part of this change.

## Validation and distribution

`check:ido` checks backend and UI types. `build:ido` checks import boundaries, bundles each runtime, builds four React/Mantine entries, and embeds Dashboard runtime/assets in the Engine tarball. `pack:ido` produces Engine, Client, Dashboard and Discord packages. Engine requires neither Discord nor Codex dependencies to start.

`test:ido` covers independent reply/minutes failure, duplicate input, ordered concurrency, role/generation fences, plugin shutdown, backup migration, Client reconnect/approval/control and previews. `smoke:ido` exercises browser setup, business views, Client pairing, Dashboard stop/restart and sandboxed preview operations. `smoke:ido:pack` installs fresh local tarballs and verifies their runtime/UI. These tests use synthetic users, mocked providers and local services; live provider credentials and publication are separate deployment work.
