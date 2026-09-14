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

The task workspace uses Mantine with light, dark and system appearance options in User settings. The default follows the OS; manual selection is applied immediately and saved in browser localStorage (`ido.color-scheme`). Its right panel has Environment, Sources and Changes tabs; on narrow screens, Task details opens the panel from the right. The sidebar uses compact task rows: running work shows a spinner, finished results show a dot until viewed in the foreground, and read results have no indicator. Read markers are stored locally per account/Engine and result revision (`ido.task-read.v1`); task content is not stored there. Task menus appear on hover or keyboard focus (always available on touch screens). Environment shows the actual Git branch (or detached HEAD), working directory, device and assignee. Changes shows the current local diff and can be refreshed.

New executions snapshot the task's attached meeting statements and the executing user's configured profile context, pass that snapshot to the agent as reference material, and show the same text in Sources. Profile snapshots are preserved when continuing a task. Older executions without a snapshot are labelled accordingly. Shared task views show attached meeting statements and shared device metadata; local profile snapshots, paths and diffs are not added to team summaries.
