# IDO Client

Self-hosted IDO Client. Requires Node.js 24.x. Package names are provisional; no publication is performed by the repository build.

See the repository's `docs/ido-engine-client.md` for setup, supported platforms, protocol boundaries and live deployment checks.

```sh
ido-client start
ido-client status
ido-client doctor
ido-client stop
```

The local React/Mantine dashboard is bundled with Client at port 4320. Connection/setup and execution/approval pages are independent of the business Dashboard plugin. Local journals, worktrees, approvals and explicit preview registrations remain on this Client.
