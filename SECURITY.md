# Security policy

Do not include tokens, OAuth codes, client secrets, private keys, private messages or installation-specific configuration in public issues, logs or commits.

## Current system

- Engine and Client credentials default to plaintext `secrets.json` files in their application data directories, with owner-only file permissions on POSIX. Protect the OS account and its backups.
- Engine administrator sessions use password hashes, HttpOnly cookies, Origin checks and CSRF tokens. Remote management requires HTTPS.
- Only explicitly paired Clients receive tasks, within their local repository and execution grants. Codex authentication remains on the Client.
- Generated previews use short-lived capabilities and an opaque-origin sandbox. The relay does not forward management cookies or Authorization headers to generated apps.
- Plugins run in separate processes, which provides crash isolation, not an OS security sandbox.
- Untrusted conversation and generated content cannot authorize permission changes.

See `docs/ido-engine-client.md` for the implemented trust boundaries. The archived application's security notes are retained with its source and are not the current runtime contract.
