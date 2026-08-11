#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${PERSONAL_CONTEXT_NODE:-}" ]]; then
  if [[ ! -x "$PERSONAL_CONTEXT_NODE" ]]; then
    echo "PERSONAL_CONTEXT_NODE is not executable: $PERSONAL_CONTEXT_NODE" >&2
    exit 1
  fi
  printf '%s\n' "$PERSONAL_CONTEXT_NODE"
  exit 0
fi

if command -v node >/dev/null 2>&1; then
  command -v node
  exit 0
fi

node_executable=""
for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
  if [[ -x "$candidate" ]]; then
    node_executable="$candidate"
  fi
done

if [[ -z "$node_executable" ]]; then
  echo "Node.js was not found. Install Node 22+ or set PERSONAL_CONTEXT_NODE." >&2
  exit 1
fi

printf '%s\n' "$node_executable"
