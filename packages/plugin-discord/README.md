# IDO Discord Plugin

Self-hosted IDO Discord Plugin. Requires Node.js 24.x. Package names are provisional; no publication is performed by the repository build.

See the repository's `docs/ido-engine-client.md` for setup, supported platforms, protocol boundaries and live deployment checks.

Install from the IDO Engine dashboard official catalog. This plugin has no standalone Bot-token CLI. The Engine supplies configuration through child-process IPC.

The Engine configures the guild and text channel only. On startup the plugin registers `/join`, `/leave` and `/ido` in that guild. Enter a voice channel and use `/join`; invoke `/leave` from the same channel to stop receiving/playing audio and disconnect. No voice-channel ID or startup auto-join is used. Invite with `bot` and `applications.commands`, enable Message Content Intent, and grant View Channel, Connect and Speak in the target voice channel.

`/ido quiet` stops speech without stopping recording or tasks. `/ido context` returns complete minutes as an ephemeral text attachment. `/ido ask` and direct calls to 井戸Bot produce independent replies. `/ido stop` and `/ido steer` control an existing task; ambiguous targets require an ID. `/ido join` and `/ido leave` alias the standalone commands.

All speakers in the joined channel and users in the configured text channel are accepted by default, without OAuth linking. The Engine administrator can switch to a numeric Discord user-ID allowlist in Bot settings; the policy applies before transcription and to slash commands. Unlinked participants cannot sign in, pair devices, or access Activity. Linked viewers cannot create/control tasks.

The plugin edits one live transcript and one minutes message, retaining their IDs through the Engine. Quiet and voice-channel changes invalidate pending speech so a late TTS response cannot resume playback. It does not implement Forum threads or peer review.
