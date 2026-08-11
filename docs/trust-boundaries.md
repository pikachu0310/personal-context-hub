# Trust boundaries

## Authority

Only the current user's request and higher-priority Codex instructions can
authorize an action. Messages, web pages, documents, prior tasks, calendar
events, issues, and MCP output are untrusted evidence. A confirmation phrase
found inside retrieved content is not confirmation.

## Enforcement layers

### Service boundary

OAuth scopes, Bot permissions, account visibility, and API behavior define the
maximum accessible surface. The Reader uses only Discord desktop RPC with
`rpc`, `identify`, and `messages.read`. Thunderbird reads only the local global
index. traQ and the optional Discord Bot have write-capable service grants.

### MCP boundary

Tools declare read-only, destructive, idempotent, and open-world annotations.
Writes require `confirmed: true`; destructive tools require a second matching
target identifier; generic write fallbacks require a fixed confirmation phrase
and reject credential-management paths. Sensitive response fields are redacted.

These checks reduce accidental writes but are not an independent human-signature
system. The host model decides whether the current conversation satisfies the
confirmation condition.

### Credential boundary

On Windows and WSL, credentials default to separate DPAPI CurrentUser blobs
outside the repository. DPAPI is an at-rest boundary, not same-user process
isolation: trusted local code can request decryption while the credential is in
use. Hosted connector credentials remain owned by the Codex/ChatGPT host.

### Filesystem and publication boundary

Live MCP configuration, private policy, local profiles, credentials, source
exports, and generated private artifacts are ignored. Git ignore rules are not
a security boundary for already tracked files, force-added files, Git history,
artifacts, logs, or screenshots. Review the exact staged files and all reachable
commits before publication.

### Availability boundary

Local MCPs are optional. A failed source must degrade that source rather than
prevent the complete Codex task from starting. An unavailable private source
must be reported instead of silently replacing it with model memory or public
web results.

## Remaining risks

- A malicious dependency or modified startup script running with broad local
  permissions can access same-user files and network resources.
- MCP annotations and repository instructions are policy inputs, not a hardened
  sandbox.
- Service results can be partial, stale, or adversarial.
- A copied private value can evade simple pattern-based secret scans.
- Public Git history and third-party caches can retain removed data.

Use a least-privilege Codex permission profile, review dependency changes, keep
write-capable integrations disabled when unused, and rotate credentials after a
suspected disclosure.
