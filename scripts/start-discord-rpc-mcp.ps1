$ErrorActionPreference = "Stop"
$serverPath = Join-Path (Split-Path $PSScriptRoot -Parent) "src\discord-rpc-server.mjs"
& node.exe $serverPath
exit $LASTEXITCODE
