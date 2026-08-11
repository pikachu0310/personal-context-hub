#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_dir/.." && pwd)"
node_executable="$("$script_dir/resolve-node.sh")"
cd "$repository_root"
exec "$node_executable" src/discord-server.mjs
