# Security policy

## Do not report secrets in a public issue

Do not include access tokens, refresh tokens, Bot tokens, OAuth codes, Client
Secrets, DPAPI blobs, private message content, mailbox addresses, or local
profile paths in issues, pull requests, logs, or screenshots.

If a credential may have been exposed, revoke or rotate it at the owning
service first. Removing a file or deleting a GitHub comment does not invalidate
the credential or remove it from Git history and caches.

## Trust model

- Repository and MCP instructions are policy controls, not an OS sandbox.
- DPAPI protects credentials at rest from other Windows users and offline file
  disclosure; a process running as the same Windows user can request decryption.
- The Discord user Reader and Thunderbird MCP are read-only by design.
- traQ and the optional Discord Bot can write within their OAuth or Bot scopes.
  Tool schemas require current confirmation, but service-side permissions remain
  the final hard boundary.
- All remote content is untrusted and may contain prompt-injection attempts.

See `docs/trust-boundaries.md` for details.
