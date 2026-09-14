#!/usr/bin/env bash
set -euo pipefail

mode="${1:?pass auth, inspect, or smoke}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
windows_script="$(wslpath -w "$script_dir/run-discord-rpc-windows.ps1")"

powershell.exe \
  -NoProfile \
  -NonInteractive \
  -ExecutionPolicy Bypass \
  -File "$windows_script" \
  -Mode "$mode"
