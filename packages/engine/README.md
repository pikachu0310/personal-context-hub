# IDO Engine

Self-hosted IDO Engine. Requires Node.js 24.x. Package names are provisional; no publication is performed by the repository build.

See the repository's `docs/ido-engine-client.md` for setup, supported platforms, protocol boundaries and live deployment checks.

```sh
ido-engine start
ido-engine status
ido-engine doctor
ido-engine stop
```

Administration is a bundled React/Mantine UI at `/admin`. The independent Dashboard plugin is also bundled and starts at `/dashboard/`; its failure does not stop administration or Client processing. Discord remains optional. Plugins communicate over versioned IPC and cannot import Engine internals.

Existing Engine data is upgraded transactionally to schema version 1 after creating `engine.before-v1.sqlite`. Messages and provider IDs are separated without replaying uncertain processing. Stop the previous Engine before upgrading; keep its data directory and backup. See `docs/packages-architecture.md` in the repository for rollback and extension contracts.
