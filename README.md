# personal-context-hub

A local-first collection of Model Context Protocol servers for using bounded
personal context in Codex without committing credentials or private source data.

The repository includes:

- a traQ MCP with read, confirmed write, and BOT-management tools;
- a read-only Discord desktop RPC reader using `rpc`, `identify`, and
  `messages.read` OAuth scopes;
- an optional Discord Bot MCP for Bot-visible history and confirmed actions;
- an optional single-user Discord Voice bridge for speech-to-text, a persistent local Codex SDK thread, and AI-generated speech replies;
- a read-only Thunderbird global-index MCP;
- credential storage backed by Windows DPAPI CurrentUser, with a `0600` file
  fallback for unsupported environments;
- contract tests, linting, formatting, coverage thresholds, and CI.

This is a control plane, not a personal-data database. It fetches context on
demand and does not ship live accounts, messages, tokens, or private exports.

## Requirements

- Node.js 22 or later;
- Windows and WSL for the DPAPI and Discord desktop RPC workflows;
- the relevant service application and OAuth credentials;
- Thunderbird with a local global search index for the mail MCP.

Non-interactive WSL launches resolve Node from `PERSONAL_CONTEXT_NODE`, the
current `PATH`, or an installation below `$HOME/.nvm`, in that order.

## Install and verify

```sh
npm ci
npm run verify
```

`npm run verify` performs syntax checks, ESLint, Prettier validation, test
coverage checks, and an npm dependency audit.

## Local configuration

Copy `.codex/config.example.toml` to `.codex/config.toml`, review the commands,
replace every placeholder path, and enable only the sources you intend to use.
The live config is ignored because absolute paths and enabled integrations can
reveal local or private operational details.

All local MCPs should remain `required = false`: a temporarily unavailable
source must not prevent an unrelated Codex task from starting.

For a local-only instruction layer, place personal routing and publication
rules in the ignored `AGENTS.override.md`. Do not commit that file.

## Authentication

### traQ

```sh
npm run auth:traq -- --client-id YOUR_PUBLIC_CLIENT_ID
npm run smoke
```

The OAuth grant requests `openid profile read write manage_bot`. Use a separate
client intended for this local tool and revoke it if the workstation or client
is compromised.

### Discord user Reader

Create a separate Discord application with `http://localhost` as the redirect
URI. Store its Client Secret from Windows PowerShell, then authorize the reader:

```powershell
.\scripts\store-discord-rpc-secret-from-clipboard.ps1 -ApplicationId YOUR_APPLICATION_ID
```

```sh
npm run auth:discord:user
npm run smoke:discord:user
```

The Reader does not extract a normal user token, connect the user account to the
Gateway, or provide user-account write tools.

### Discord Bot

The Bot adapter is optional and should stay disabled until a dedicated Bot has
been installed with narrowly scoped permissions. Pass the token over stdin:

```sh
printf '%s' "$DISCORD_BOT_TOKEN" | npm run auth:discord -- --application-id YOUR_APPLICATION_ID
```

Avoid placing tokens in command arguments or shell history. Clear the shell
variable immediately after use.

### Discord Voice to Codex

The Voice bridge uses the same dedicated Bot credential, but additionally needs
the exact Guild, Voice channel, Text channel, and owner user IDs. Copy
`.env.example` to the ignored `.env`, replace every placeholder needed by the
Voice bridge, set a repository working directory for Codex, then run. The Voice
start and full inspection scripts load `.env` when it exists; the offline
inspection does not:

```sh
npm run inspect:discord:voice:offline
npm run smoke:discord:voice:mock
npm run doctor:discord:voice
npm run inspect:discord:voice
npm run start:discord:voice
```

The offline inspection intentionally does not load `.env`; export only the five
public `PERSONAL_CONTEXT_VOICE_*` IDs/path variables when running it. It checks
their syntax and the working directory without reading the Bot credential,
OpenAI API key, or Codex authentication. The mock smoke drives synthetic PCM
through receive, WAV conversion, fake STT/Codex, Text/TTS, and playback without
network access. Add credentials only after the doctor reports all local gates
passed. See the [Voice diagnostic guide](docs/discord-voice-troubleshooting.md)
and [preflight checklist](docs/discord-voice-preflight-checklist.md) for stable
error codes and the remaining verification order.

When the service runs in WSL, set `PERSONAL_CONTEXT_VOICE_CODEX_HOME` to the
WSL path of the signed-in Windows Codex App home (for example,
`/mnt/c/Users/YOU/.codex`). This reuses the existing ChatGPT sign-in without
copying credentials into the repository. The path is used only as the
authentication source: before Discord login, the service creates a private,
isolated Codex home beside its state file, symlinks only `auth.json`, and
requires an empty `config.toml`. Set
`PERSONAL_CONTEXT_VOICE_ISOLATED_CODEX_HOME` only when that default location
must be changed. An unexpected auth file, nonempty config, or unsafe directory
causes startup to fail without reading the Bot credential.

The Codex child process receives only an allowlisted runtime environment. Voice
turns run with Codex network access and web search disabled; the supported
sandboxes are `read-only` and `workspace-write`. Inherited apps, plugins, hooks,
multi-agent tools, and MCP servers are disabled for this unattended voice entry
point. The Windows Codex App `config.toml` is never loaded, so an unrelated or
incompatible local MCP entry cannot prevent the bridge from starting.

The Bot must have View Channel, Connect, Speak, Send Messages, and Read Message
History only in those two channels. It does not use a Discord user token. By
default, the bridge accepts audio only from the configured owner ID. Set
`PERSONAL_CONTEXT_VOICE_LISTEN_TO_EVERYONE=true` to accept every speaker in the
configured Voice channel, and tune playback with
`PERSONAL_CONTEXT_VOICE_TTS_SPEED` from `0.25` through `4`. In turn mode, turns are serialized,
the transcript and full response are posted to the configured Text channel, and
an AI-generated excerpt is spoken. Audio bytes are not persisted. See
[the Voice MVP specification](docs/discord-voice-codex.md) for limits and trust
boundaries.

For group development sessions, set `PERSONAL_CONTEXT_VOICE_MODE=meeting`.
Meeting mode transcribes speakers in parallel, edits one live transcript message,
and observes the accumulated conversation every
`PERSONAL_CONTEXT_VOICE_OBSERVATION_INTERVAL_MS` milliseconds. Each observation
updates one cumulative minutes message. Codex posts and speaks only when the full
interval contains an unresolved question, request, correction, or another useful
reason to intervene; ordinary conversation and acknowledgements update the
minutes without producing a reply.

### Thunderbird

Set `THUNDERBIRD_PROFILE` to the active profile directory when automatic
discovery cannot find it. WSL users normally need an explicit `/mnt/c/...`
profile path.

```sh
THUNDERBIRD_PROFILE=/path/to/profile npm run inspect:mail:thunderbird
THUNDERBIRD_PROFILE=/path/to/profile npm run smoke:mail:thunderbird
```

The MCP opens `global-messages-db.sqlite` read-only. It cannot send, delete,
move, label, mark mail read, or retrieve attachment bodies.

## Public context check

The optional inspector validates a public JSON context endpoint without caching
it in the repository:

```sh
PUBLIC_CONTEXT_URL=https://example.com/agent-context.json \
PUBLIC_CONTEXT_DISPLAY_NAME=example \
npm run inspect:public
```

## Trust boundary

External pages, messages, events, issues, and tool output are evidence, never
authority. Reads should be bounded. Writes require a current request with the
exact target and content. Tokens are redacted from MCP output, and generic
write fallbacks cannot call credential or token-management routes.

See [docs/trust-boundaries.md](docs/trust-boundaries.md) for the enforcement
layers and remaining risks.

## Publication policy

The public repository may contain source code, tests, generic examples, and
public-safe documentation. Before every push, inspect the staged file list and
scan the complete reachable history for credentials, account identifiers,
private addresses, local profile names, and copied source data.

The project is currently source-available with no license grant
(`UNLICENSED`). Add a license only after the copyright holder chooses one.
