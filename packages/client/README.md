# IDO Client

Self-hosted IDO Client. Requires Node.js 24.x. Package names are provisional; no publication is performed by the repository build.

See the repository's `docs/ido-engine-client.md` for setup, supported platforms, protocol boundaries and live deployment checks.

Browser and desktop launches retain identity in the same local data directory.
See [identity and restart behavior](../../docs/client-identity.md) for recovery,
re-pairing, historical participant display, and the local Codex account status.

```sh
ido-client start
ido-client status
ido-client doctor
ido-client stop
```

The local React/Mantine dashboard is bundled with Client at port 4320. Connection/setup and execution/approval pages are independent of the business Dashboard plugin. Local journals, worktrees, approvals and explicit preview registrations remain on this Client.
