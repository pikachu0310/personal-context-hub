param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("auth", "inspect", "smoke")]
  [string]$Mode
)

$ErrorActionPreference = "Stop"
$scriptName = switch ($Mode) {
  "auth" { "auth-discord-rpc.mjs" }
  "inspect" { "inspect-discord-rpc-auth.mjs" }
  "smoke" { "discord-rpc-smoke.mjs" }
}
$scriptPath = Join-Path $PSScriptRoot $scriptName
& node.exe $scriptPath
exit $LASTEXITCODE
