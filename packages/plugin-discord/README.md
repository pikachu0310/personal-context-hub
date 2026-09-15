# IDO Discord Plugin

Self-hosted IDO Discord Plugin. Requires Node.js 24.x. Package names are provisional; no publication is performed by the repository build.

See the repository's `docs/ido-engine-client.md` for setup, supported platforms, protocol boundaries and live deployment checks.

Install from the IDO Engine dashboard official catalog. This plugin has no standalone Bot-token CLI. The Engine supplies configuration through child-process IPC.

The Engine configures the guild and text channel only. On startup the plugin registers `/project`, `/join`, `/leave` and `/ido` in that guild. Enter a voice channel and use `/join`; invoke `/leave` from the same channel to stop receiving/playing audio and disconnect. An optional `voiceChannelId` joins that voice channel on startup. Invite with `bot` and `applications.commands`, enable Message Content Intent, and grant View Channel, Connect and Speak in the target voice channel.

`/ido quiet` stops speech without stopping recording or tasks. `/ido context` returns complete minutes as an ephemeral text attachment. `/ido ask` and direct calls to 井戸Bot produce independent replies. `/ido stop` and `/ido steer` control an existing task; ambiguous targets require an ID. `/ido join` and `/ido leave` alias the standalone commands.

All speakers in the joined channel and users in the configured text channel are accepted by default, without OAuth linking. The Engine administrator can switch to a numeric Discord user-ID allowlist in Bot settings; the policy applies before transcription and to slash commands. Unlinked participants cannot sign in, pair devices, or access Activity. Linked viewers cannot create/control tasks.

The plugin edits one current live transcript per text channel and a minutes message per meeting, retaining their IDs through the Engine. Quiet and voice-channel changes invalidate pending speech so a late TTS response cannot resume playback. Task summaries can also be synchronized to the configured issue Forum.

## Project selection

The Bot starts in the default project when no valid project is configured.
`/project name:<project name>` switches to an existing project by its name,
or by selecting an autocomplete suggestion. Omitting `name` shows the current
project and an ephemeral project selection menu, with pages for more than 25
projects. Autocomplete filters names and IDs as you type. Unknown and ambiguous names are rejected; the command never creates a
project. The selected project persists across restarts. If it has been deleted,
startup falls back to the default project. Existing user policies still apply.

The current transcript header includes `現在のプロジェクト: <name>`. It is
refreshed on startup and project selection even before anyone speaks, and the
same transcript card is reused after a switch. Pending output from the previous
project is discarded. Dashboard and Activity show the Bot's selected project
separately from their own project viewing/filter controls.
