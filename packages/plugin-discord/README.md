# IDO Discord Plugin

Self-hosted IDO Discord Plugin. Requires Node.js 24.x. Package names are provisional; no publication is performed by the repository build.

See the repository's `docs/ido-engine-client.md` for setup, supported platforms, protocol boundaries and live deployment checks.

Install from the IDO Engine dashboard official catalog. This plugin has no standalone Bot-token CLI. The Engine supplies configuration through child-process IPC.

The Engine configures the guild and text channel only. On startup the plugin registers `/join` and `/leave` in that guild. Enter a voice channel and use `/join`; invoke `/leave` from the same channel to stop receiving/playing audio and disconnect. No voice-channel ID or startup auto-join is used. Invite with `bot` and `applications.commands`, enable Message Content Intent, and grant View Channel, Connect and Speak in the target voice channel.
