# IDO Engine / Client

IDO is a self-hosted team engine. It records conversations and minutes, turns explicit implementation requests into tasks, and assigns tasks to members' locally approved Codex clients. The Engine never runs Codex. The Discord plugin is optional and runs in a child process.

The `@ido/*` names are provisional. This branch builds installable npm tarballs; it does not publish packages to the registry. Until publication, use the tarball commands below. Existing hub integrations and their data remain separate; no legacy configuration is read or migrated.

## Install

Use Node.js **24.x**, npm, and Git on macOS, Linux/WSL, or native Windows. Only Clients need Git and Codex authentication. The Client package supplies its own pinned Codex CLI binary through official platform packages.

After package publication:

```sh
npm install -g @ido/engine
ido-engine start
```

The first start prompts for the administrator name and a password of at least 12 characters in the terminal. No unauthenticated web registration endpoint exists. For a headless host, use `ido-engine init --name admin --password-stdin` and pipe a password from your secret manager; do not put passwords in command arguments. Then run `ido-engine start --no-open`.

The dashboard opens at `http://127.0.0.1:4310`. The preview relay uses port 4311. `--port` and `--preview-port` change these. Processes remain in the foreground; use a second terminal for `stop`, `status`, or `doctor`. OS service registration is intentionally not included. After a crash, `doctor --recover` removes a stale process lock only if the recorded process has stopped.

In the dashboard:

1. Save an OpenAI API key and run its connection check.
2. Create a project and a meeting; associate the meeting with a project to enable task extraction from implementation requests.
3. Add the catalog's Discord plugin. Dependencies install into the Engine data directory, not the global npm package directory.
4. Create a Discord application and Bot, enable Message Content Intent, invite the Bot, and configure the guild and channels. Grant only View Channel, Send Messages, Connect and Speak for the chosen channels. Voice reception uses Discord's voice library; obtain participants' agreement before enabling recording in a channel.
5. Save Application ID and OAuth Client Secret. Start the plugin. Link each IDO member to their own Discord account using the dashboard. Unlinked Discord users cannot submit work or access Activity data.
6. Set two distinct HTTPS origins and configure the reverse proxy or a tunnel. Complete the independent connection checks.

Guidance can be hidden and redisplayed; hiding it does not mark credentials or connectivity as verified. `!ido task <instruction>` explicitly creates a task. Other text and voice messages contribute to minutes; direct implementation requests are extracted into tasks for the configured project. Model output supplies task content, never identities, roles, device grants or administration commands. The dashboard remains usable when the Discord plugin is stopped or fails.

Each member installs and starts a Client:

```sh
npm install -g @ido/client
ido-client start
```

The local Client dashboard opens at `http://127.0.0.1:4320` (`--port` overrides it). Start the official Codex device login and follow the terminal instructions. Its `CODEX_HOME` is a dedicated subdirectory of the Client data directory. Existing personal Codex authentication, config and MCP wiring are not copied.

Enter the Engine HTTPS origin, open the displayed confirmation link, log into IDO, and compare the device fingerprint before approving. The Client polls outward to complete pairing; the Engine page never calls localhost. Pair requests expire in five minutes and are redeemed once. The Engine stores the public device key; the private key stays in the Client's credential store.

Map team projects to existing local Git repositories. Confirm network access and concurrency, then enable automatic execution for the current Client session. Default concurrency is one. New processes require a fresh local opt-in. Additional Codex permission requests appear only in the local approval screen and expire after five minutes. Declining or timing out does not grant additional access. Stopping automatic acceptance does not implicitly stop work already running; use the execution's Stop action.

## Storage and trust boundaries

Default application data lives under the current account's application data location: macOS Application Support, Windows LocalAppData, or Linux XDG data home. `IDO_DATA_DIR` explicitly chooses another directory for one process. The Engine and Client use separate directories by default.

- Engine: SQLite users, password hashes (salted scrypt), sessions, projects, meetings, tasks, delivery outbox, device registration, service identity links and operation audit.
- Client: repo mappings and a durable command/run journal, worktrees, and a dedicated Codex home.
- Secrets: macOS Keychain, Windows DPAPI, Linux Secret Service. A headless host without an available store falls back to an owner-only credential file. `IDO_CREDENTIAL_BACKEND=file` explicitly selects this fallback for a headless deployment or distribution tests. Protect the containing account and backups; this is not OS sandbox isolation.
- Settings APIs expose only presence flags for secrets. Audit entries contain actor/action/target IDs, not configuration values or conversation bodies.

IDO roles are admin, member and viewer. Team members share projects and meetings in this first version; per-project membership isolation is not implemented. Only admins change plugin packages, credentials, public URLs, members or roles. Sessions are HttpOnly, expire after eight hours, and use CSRF tokens and origin checks. HTTPS sessions use Secure cookies. Login attempts are limited. Initial administrator creation always happens locally.

The HTTP server binds to loopback. A reverse proxy must preserve the public Host and set `X-Forwarded-Proto: https`; only a proxy connecting from loopback is trusted. Do not bind the management process directly to a public interface. The same contract applies to the WebSocket `/connect` route. Client origins are explicitly configured and must be HTTPS except for loopback testing.

The task allocator chooses connected, non-revoked devices with the project mapping, required network grant and free capacity. It prioritizes more free slots, then the least recently assigned device. Assignment and its delivery command commit in one SQLite transaction before sending. Every command has an ID; every task has a run ID and revision. Connections have monotonically increasing generations. A new connection replaces the old one. Stale results cannot overwrite a newer revision.

Disconnected work remains assigned. A Client restart marks uncertain running work interrupted and preserves its worktree. It never silently starts that work on another machine. Retry is explicit and remains on the same device/worktree; it increments the revision. Additional instructions use Codex App Server `turn/steer`. An ambiguous delivery is not automatically repeated. An instruction arriving after a turn has ended is reported so the member can submit it in a new execution. Repositories must have a committed HEAD for worktree creation. The Client does not silently commit the user's working tree.

## Discord Activity and previews

Follow [Discord's Activity setup](https://docs.discord.com/developers/activities/building-an-activity) and [networking requirements](https://docs.discord.com/developers/activities/development-guides/networking). Configure:

| Setting                | Value                                                                  |
| ---------------------- | ---------------------------------------------------------------------- |
| OAuth redirect         | `https://engine.example.com/api/discord/callback`                      |
| URL Mapping `/`        | Engine's HTTPS host                                                    |
| URL Mapping `/preview` | Preview's separate HTTPS host                                          |
| Browser Activity entry | `/activity` (Discord frame query parameters also select Activity mode) |

The Embedded App SDK supplies an authorization code; token exchange and identity verification occur in the Discord plugin process. The Engine maps the verified Discord identity to an existing IDO member. Activity receives a separate, short-lived bearer credential for its limited routes. It never receives a management session or OAuth Client Secret. Discord access tokens used for the SDK's authenticate command are held in memory.

To expose a generated app, start it on a loopback port from the worktree and explicitly register that port in the local Client's execution panel. No remote route can choose an arbitrary URL or local port. The relay pins each registration to task/run/revision, caps request and response bodies at 1 MiB, and expires the registration after one hour; issued view capabilities last at most 15 minutes. Disconnection clears active registrations. A new revision invalidates old preview capabilities.

The app must support relative assets or use the supplied `X-Forwarded-Prefix` base path. A minimal compatible app is in `examples/ido-preview/`. HTTP methods, forms and WebSocket frames travel over the authenticated Client connection. Request cookies and Authorization headers and response Set-Cookie headers are not relayed. Both response CSP and the UI iframe apply `sandbox allow-scripts allow-forms`; there is no `allow-same-origin`, pop-up or top-navigation escape. Capability paths are bearer credentials scoped to one preview: do not share them beyond intended viewers. No referrer is sent. Ordinary browsers use a different preview origin; Activity uses its separately mapped sandbox iframe.

External OAuth, WebRTC, absolute root asset paths and device-specific APIs are outside the supported preview contract. Do not loosen sandbox flags to accommodate an incompatible app. Authentication and mutable app-specific state must fit the sandbox; management credentials are never a compatibility fallback.

Cloudflare/ngrok accounts and fixed domains must be prepared with the provider. The dashboard installs the selected adapter and starts/stops it. Configure Cloudflare public hostnames to forward to Engine and Preview ports separately. ngrok requires two reserved endpoints supported by the account. Tunnel process startup is not proof of usable deployment: HTTPS reachability, actual Client WSS connection, Discord Activity and a separate-network device must all be checked. URL changes require updating Discord mappings and explicit Client registration to the new origin.

## Build and verify without publishing

```sh
npm ci
npm run verify:ido
npm run smoke:ido
npm run pack:ido
npm run smoke:ido:pack
```

The last command installs the tarballs into new temporary directories, checks that the Engine has no Codex/Discord dependency, starts/stops both distributions and installs the plugin from its local tarball. Local release testing can use:

```sh
npm install -g ./ido-engine-0.2.0.tgz
ido-engine plugin-install --tarball /absolute/path/ido-plugin-discord-0.2.0.tgz
```

`plugin-install --tarball` is a local CLI development/release operation, not a browser endpoint. The browser installer accepts only the catalog's package and version. Installation validates package identity, JavaScript syntax and the plugin protocol handshake before replacing the active installation. Failed installs leave the previous installation selected. Plugin processes are crash-contained but run with the host user's OS permissions. Official catalog membership is a trust decision, not an OS sandbox.

CI adds macOS/Linux/Windows Node 24 checks, npm artifact installation, and a Chromium workflow. Legacy integration regressions remain in the existing suite. Automated tests use synthetic accounts, mocked Codex execution and loopback connections; they do not prove live Discord Activity approval, real multi-PC networking, provider accounts, Codex login or execution on operating systems not actually run. Those deployment checks need configured test accounts and devices. npm publication, pushing this branch, releases, and public Discord application publication remain separate external actions.
