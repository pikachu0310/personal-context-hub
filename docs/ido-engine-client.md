# IDO Engine / Client

For the native Windows/Mac Client, Discord installation guidance and issue forum synchronization, see [IDO Agent and issue forum setup](main2-desktop-forum.md). CLI usage below remains available.

IDO is a self-hosted team engine. It records conversations, keeps a persistent main Codex model per meeting, and supervises work delegated to members' locally approved Codex Clients. The main model runs on Engine with its own Codex authentication and home; Clients run actual repository work in their independent environments. Dashboard and Discord are independent child-process plugins. Dashboard is bundled and starts by default; Discord is optional. Engine administration remains available if either stops.

The `@ido/*` names are provisional. This branch builds installable npm tarballs; it does not publish packages to the registry. Until publication, use the tarball commands below. Existing hub integrations and their data remain separate; no legacy configuration is read or migrated.

## Engine error diagnostics

Administrators can open **エラーログ** in the Engine dashboard. Discord failures include an error ID that links the notification to the stored diagnostic. Logs distinguish transcription, coordinator input, answers, speech output and task creation, with timestamps, related input/meeting/message IDs, model, HTTP status, known error code, network cause and OpenAI request ID when available. Speech/answer failures preserve recorded statements. The legacy mode also retains independent reply/minutes failure states.

Diagnostics are stored in `engine.sqlite` in the same Engine data directory selected by `IDO_DATA_DIR`. They survive restarts; the latest 500 records are retained and the dashboard shows the newest 100. Only administrators receive these records. Raw provider messages, request/response bodies, headers, audio, transcripts and stacks are excluded because they can contain secrets or private content. Unknown error codes receive a generic explanation. Failures from before this feature cannot be reconstructed.

The OpenAI connection check reads the model list; success verifies authentication/connectivity, not available usage quota. A transcription failure with HTTP 429 and `insufficient_quota` requires checking API billing, credits and usage limits. A `rate_limit_exceeded` failure indicates request throttling instead. After rebuilding the Engine, restart it with the same data directory to load the new code and dashboard.

## Install

Use Node.js **24.x**, npm, and Git on macOS, Linux/WSL, or native Windows. Clients need Git for their repository worktrees. Both Engine and Clients supply the official pinned Codex runtime and need their own Codex authentication when using it; existing personal authentication is not copied.

After package publication:

```sh
npm install -g @ido/engine
ido-engine codex-login
ido-engine codex-status
ido-engine start
```

The first start prompts for the administrator name and a password of at least 12 characters in the terminal. No unauthenticated web registration endpoint exists. For a headless host, use `ido-engine init --name admin --password-stdin` and pipe a password from your secret manager; do not put passwords in command arguments. Then run `ido-engine start --no-open`.

The default conversation mode is `text-speech`. Use `start --conversation-mode live` to make Live the default for new meeting sessions, or `--conversation-mode legacy` for the previous packages-based Responses reply/minutes path. Existing meetings resume their saved mode. The persistent main model defaults to `gpt-5.6-sol` with low reasoning effort; `--main-model` selects another model. `--codex-home` overrides the Engine main model's home; use the same value for login, status and start. Its default is `<engine-data>/codex`, separate from every Client's home. Main model tools for repository work are disabled; investigation and implementation are delegated through WorkPort. See [conversation modes](conversation-modes.md).

Engine administration opens at `http://127.0.0.1:4310/admin`. Business views run at `/dashboard/`. Public previews use `/preview/` on the same Engine host. Port 4311 remains an internal relay listener and does not need a public tunnel. `--port` and `--preview-port` change these. Processes remain in the foreground; use a second terminal for `stop`, `status`, or `doctor`. OS service registration is intentionally not included. After a crash, `doctor --recover` removes a stale process lock only if the recorded process has stopped.

In Engine administration and Dashboard:

1. Save an OpenAI API key and run its connection check.
2. Open **業務Dashboard** and create a project and a meeting; associate the meeting with a project to enable task extraction from implementation requests.
3. Return to Engine administration and add the catalog's Discord plugin. Copy the project and meeting IDs from Dashboard into its binding settings. Dependencies install into the Engine data directory, not the global npm package directory.
4. Create a Discord application and Bot, enable Message Content Intent, invite the Bot with `bot` and `applications.commands`, and configure the guild and text channel. Grant only View Channel, Send Messages, Connect and Speak for the chosen channels. Voice reception uses Discord's voice library; obtain participants' agreement before enabling recording in a channel.
5. Save Application ID and OAuth Client Secret. Start the plugin; it registers `/join`, `/leave` and `/ido` in the configured guild. Join a voice channel yourself and invoke `/join` to bring the Bot there. `/leave` from the same channel disconnects it and stops audio reception/playback. Startup no longer auto-joins a configured voice channel; old voice-channel settings are ignored. Link each IDO member to their own Discord account using the account-link action in Engine setup. By default, everyone in the joined voice channel or configured text channel can contribute and request/control tasks without linking. Activity access still requires linking. In Bot settings, select an explicit Discord user-ID allowlist to restrict reception and commands; an empty allowlist permits nobody. These settings apply immediately. Unlinked speakers receive conversation-only identities, never dashboard accounts or device grants.
6. Set one HTTPS origin, or use the ngrok button to acquire it automatically. Complete the independent connection checks.

Guidance can be hidden and redisplayed; hiding it does not mark credentials or connectivity as verified. `!ido task <instruction>` explicitly creates a task. Other text and voice messages enter the meeting's mechanical log and persistent main-model inbox; sourced implementation proposals are checked before becoming tasks for the configured project. Read-only investigations are separate restricted Client tasks. Model output never supplies identities, roles, device grants or administration authority. The dashboard remains usable when the Discord plugin is stopped or fails.

Each member installs and starts a Client:

```sh
npm install -g @ido/client
ido-client start
```

The local Client dashboard opens at `http://127.0.0.1:4320` (`--port` overrides it). Start the official Codex device login and follow the terminal instructions. Its `CODEX_HOME` is a dedicated subdirectory of the Client data directory. Existing personal Codex authentication, config and MCP wiring are not copied.

Enter the Engine HTTPS origin, open the displayed confirmation link, log into IDO, and compare the device fingerprint before approving. The Client polls outward to complete pairing; the Engine page never calls localhost. Pair requests expire in five minutes and are redeemed once. The Engine stores the public device key; the private key stays in the Client's credential store.

Map team projects to existing local Git repositories. Confirm network access and concurrency, then enable automatic execution for the current Client session. Default concurrency is one. New processes require a fresh local opt-in. Additional Codex permission requests appear only in the local approval screen and expire after five minutes. Declining or timing out does not grant additional access. Stopping automatic acceptance does not implicitly stop work already running; use the execution's Stop action.

See [package architecture and migration](packages-architecture.md) for the plugin contract and versioned Engine database migration.

## Storage and trust boundaries

Default application data lives under the current account's application data location: macOS Application Support, Windows LocalAppData, or Linux XDG data home. `IDO_DATA_DIR` explicitly chooses another directory for one process. The Engine and Client use separate directories by default.

- Engine: SQLite users, password hashes (salted scrypt), sessions, projects, meetings/messages, coordinator inbox and thread handles, Bot output records, tasks, delivery outbox, device registration, service identity links and operation audit. Engine also has its own Codex home and restricted coordinator workspace.
- Client: repo mappings and a durable command/run journal, worktrees, and a dedicated Codex home.
- Secrets: Engine and Client default to `<data-directory>/secrets.json` on every OS, without accessing Keychain, DPAPI or Secret Service. The file contains plaintext values, is written atomically with mode `0600`, and its directory is created with mode `0700` on POSIX. No environment variable is needed. Existing OS-store values are left untouched and are not automatically migrated; re-save those values in the dashboard after restarting. Codex's own authentication remains managed by Codex in its dedicated home. Protect the containing account and backups; this is not OS sandbox isolation.
- Settings APIs expose only presence flags for secrets. Audit entries contain actor/action/target IDs, not configuration values or conversation bodies.

IDO roles are admin, member and viewer. Team members share projects and meetings in this first version; per-project membership isolation is not implemented. Only admins change plugin packages, credentials, public URLs, members or roles. Sessions are HttpOnly, expire after eight hours, and use CSRF tokens and origin checks. HTTPS sessions use Secure cookies. Login attempts are limited. Initial administrator creation always happens locally.

The HTTP server binds to loopback. A reverse proxy must preserve the public Host and set `X-Forwarded-Proto: https`; only a proxy connecting from loopback is trusted. Do not bind the management process directly to a public interface. The same contract applies to the WebSocket `/connect` route. Client origins are explicitly configured and must be HTTPS except for loopback testing.

The task allocator chooses connected, non-revoked devices with the project mapping, required network grant and free capacity. It prioritizes more free slots, then the least recently assigned device. Assignment and its delivery command commit in one SQLite transaction before sending. Every command has an ID; every task has a run ID and revision. Connections have monotonically increasing generations. A new connection replaces the old one. Stale results cannot overwrite a newer revision.

Disconnected work remains assigned. A Client restart marks uncertain running work interrupted and preserves its worktree. It never silently starts that work on another machine. Retry is explicit and remains on the same device/worktree; it increments the run revision. Additional instructions use Codex App Server `turn/steer`, with durable control receipts distinguishing queued, applied, stopped and uncertain delivery. Unaccepted instructions can remain queued for continuation; unknown delivery requires reconciliation rather than automatic repetition. Read-only/network restrictions are retained on retry and require a compatible Client. Repositories must have a committed HEAD for worktree creation. The Client does not silently commit the user's working tree. See [WorkPort](work-port-contract.md).

## Discord Activity and previews

Follow [Discord's Activity setup](https://docs.discord.com/developers/activities/building-an-activity) and [networking requirements](https://docs.discord.com/developers/activities/development-guides/networking). Configure:

| Setting                | Value                                                       |
| ---------------------- | ----------------------------------------------------------- |
| OAuth redirect         | `https://engine.example.com/plugins/discord/callback`       |
| URL Mapping `/`        | Engine's HTTPS host                                         |
| Preview path           | `/preview/` on the same host; no extra URL Mapping required |
| Browser Activity entry | `/plugins/discord/activity`                                 |

The plugin manifest registers the embedded launch query, so a root request containing `frame_id` redirects to `/plugins/discord/activity` while preserving Discord parameters. Ordinary root requests open `/admin`.

The Embedded App SDK supplies an authorization code; token exchange and identity verification occur in the Discord plugin process. The Engine maps the verified Discord identity to an existing IDO member. Activity receives a separate, short-lived bearer credential for its limited routes. It never receives a management session or OAuth Client Secret. Discord access tokens used for the SDK's authenticate command are held in memory.

To expose a generated app, start it on a loopback port from the worktree and explicitly register that port in the local Client's execution panel. No remote route can choose an arbitrary URL or local port. The relay pins each registration to task/run/revision, caps request and response bodies at 1 MiB, and expires the registration after one hour; issued view capabilities last at most 15 minutes. Disconnection clears active registrations. A new revision invalidates old preview capabilities.

The app must support relative assets or use the supplied `X-Forwarded-Prefix` base path. A minimal compatible app is in `examples/ido-preview/`. HTTP methods, forms and WebSocket frames travel over the authenticated Client connection. Request cookies and Authorization headers and response Set-Cookie headers are not relayed. Both response CSP and the UI iframe apply `sandbox allow-scripts allow-forms`; there is no `allow-same-origin`, pop-up or top-navigation escape. Capability paths are bearer credentials scoped to one preview: do not share them beyond intended viewers. No referrer is sent. Both ordinary browsers and Activity use `/preview/p/<capability>/` on the same host. Path separation is not an origin boundary: isolation relies on the enforced opaque-origin CSP sandbox (including direct navigation), iframe sandbox, management Origin checks, and stripped relay credentials. Worker and nested-frame creation are disabled.

External OAuth, WebRTC, absolute root asset paths and device-specific APIs are outside the supported preview contract. Do not loosen sandbox flags to accommodate an incompatible app. Authentication and mutable app-specific state must fit the sandbox; management credentials are never a compatibility fallback.

Use one public host for both management and previews. For ngrok:

1. Create an ngrok account and copy **Your Authtoken** from its dashboard (not an API key).
2. Open Engine setup's public-access section and paste the Authtoken. Leave the optional ngrok URL blank to use the account's assigned dev domain, or supply a reserved domain available to that account.
3. Click **ngrokで公開する**. IDO installs the SDK if needed, starts one endpoint forwarding to Engine port 4310, and saves the returned HTTPS URL. It reuses the stored token on subsequent starts.
4. Run **HTTPS・接続診断**, then open the saved URL. The free tier may display a browser warning page; verify the actual Discord Activity flow as well.
5. Use the saved host for Discord's `/` URL Mapping and the displayed OAuth callback. Remove any old `/preview` mapping to a separate host; the Engine now handles that path itself.

No second domain, separate CLI command or preview tunnel is required. For Cloudflare, prepare one public hostname forwarding to `http://localhost:4310`, save it in IDO, and supply the Tunnel token; IDO installs and starts the adapter. Manual reverse proxies forward all paths and WebSocket upgrades to the same Engine port. Tunnel process startup is not proof of usable deployment: HTTPS reachability, actual Client WSS connection, Discord Activity and a separate-network device must all be checked. URL changes require updating Discord mappings and explicit Client registration to the new origin.

## Discord conversation controls

The Bot accepts speech only from the currently joined voice channel and messages only from the configured text channel. The default **all users** policy treats these channels as trusted. Admins can edit **発言・タスク操作を受け付けるユーザー** and **許可するDiscordユーザーID** in Bot settings. Choose **指定したユーザーIDだけ許可** to enforce the list; use newlines or commas between numeric IDs. This also restricts slash commands, including join. Linked viewers remain unable to create or control tasks. OAuth linking remains required for Activity and does not grant dashboard access to unlinked speakers.

- `/ido join` and `/ido leave` are aliases for `/join` and `/leave`.
- `/ido quiet` stops current playback and discards speech replies already in flight. Recording, minutes and tasks continue; later questions can speak again.
- `/ido mode value:text-speech` and `/ido mode value:live` switch the meeting's audio conversation mode while preserving its main-model inbox and work state.
- `/ido context` returns the current minutes projection in `minutes.txt`. In coordinated modes this is a bounded mechanical transcript projection, not an export of every stored message.
- `/ido ask text:<question>` requests an answer without authorizing implementation. If source inspection is needed, the main model can delegate a read-only research task to a compatible Client. Ordinary conversation is observed without requiring a spoken reply. Voice/text calls such as “井戸Bot、この会議の目的は？” use the persistent main-model queue; Live owns direct voice replies in Live mode. The legacy mode retains its previous independent reply API.
- `/ido stop task:<ID>` and `/ido steer text:<instruction> task:<ID>` control an existing task in the configured meeting/project. The ID can be omitted only when exactly one eligible task exists, or shortened to a unique prefix. Queued task instructions update that task; running task instructions use the existing Client execution. Linked viewers cannot control tasks.
- Voice/text examples: “井戸Bot、今のタスクを止めて” and “井戸Bot、今のタスクに追加で、テストも実行して”. Ambiguous targets receive a list of IDs instead of selecting arbitrarily. Quoted and hypothetical stop phrases are not commands.

Recognized statements and their speaker/capture metadata are recorded independently of response generation. The live transcript and minutes cards are edited rather than reposted; publication IDs survive plugin restarts and only deleted cards are recreated. In coordinated modes the minutes projection is mechanical and bounded to 12,000 characters, while separate message records retain accepted text. Live uses continuous PCM alongside the independent attributed STT path. Neither raw PCM nor WAV is stored permanently. Context commands work from the configured text channel or for a member in the Bot's current voice channel and reply ephemerally.

Workspace operations `conversation/state`, `conversation/log` and `conversation/control` expose coordinator status, Bot output and explicit recovery. Recovery validates the current batch ID; restored source authority can only be re-established by the same actor through the same plugin. Unknown model input and unknown text delivery are not automatically replayed. A dedicated recovery UI is not included; see [the operation details](conversation-modes.md#通常入力即時入力復旧).

These changes do not include Forum task threads or peer review. To update an existing local installation, rebuild and package, install the updated Discord tarball with `ido-engine plugin-install --tarball ...`, and restart the Engine/plugin at an appropriate work boundary. Building alone does not replace a running process or the installed plugin copy. The Bot registers its commands on startup; rejoin with `/join` after restart.

## Build and verify without publishing

```sh
npm ci
npm run verify:ido
npm run smoke:ido
npm run pack:ido
npm run smoke:ido:pack
```

The last command installs the tarballs into new temporary directories, checks package boundaries, starts/stops both distributions and installs the plugin from its local tarball. Engine now includes its main-model Codex runtime; Discord SDK code remains in the plugin. Local release testing can use:

```sh
npm install -g ./ido-engine-0.2.0.tgz
ido-engine plugin-install --tarball ./ido-plugin-discord-0.2.0.tgz
```

`plugin-install --tarball` is a local CLI development/release operation, not a browser endpoint. The browser installer accepts only the catalog's package and version. Installation validates package identity, JavaScript syntax and the plugin protocol handshake before replacing the active installation. Failed installs leave the previous installation selected. Plugin processes are crash-contained but run with the host user's OS permissions. Official catalog membership is a trust decision, not an OS sandbox.

CI adds macOS/Linux/Windows Node 24 checks, npm artifact installation, and a Chromium workflow. Packages tests cover both coordinated conversation and the retained legacy packages path; archived `v0` tests are separate. Automated tests use synthetic accounts, mocked Codex/Live execution and loopback connections; they do not prove real Live conversation, Discord Activity approval, multi-PC networking, provider accounts, Codex login or execution on operating systems not actually run. Those deployment checks need configured test accounts and devices. The [integration mapping](main2-conversation-integration.md) distinguishes migrated features from legacy features outside scope. npm publication, pushing this branch, releases, and public Discord application publication remain separate external actions.
