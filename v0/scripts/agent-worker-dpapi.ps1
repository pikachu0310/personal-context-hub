$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Security

$Action = $env:PERSONAL_CONTEXT_DPAPI_ACTION
if (@("read", "write") -notcontains $Action) {
  throw "Action must be read or write."
}
$storeRoot = if ($env:PERSONAL_CONTEXT_AGENT_CREDENTIAL_DIR) {
  $env:PERSONAL_CONTEXT_AGENT_CREDENTIAL_DIR
} else {
  Join-Path $env:LOCALAPPDATA "personal-context-hub"
}
$storePath = Join-Path $storeRoot "agent-worker.dpapi"
$entropy = [Text.Encoding]::UTF8.GetBytes("personal-context-hub/agent-worker/v1")
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
if ($Action -eq "write") {
  $plaintext = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($plaintext)) { throw "Refusing to store an empty Worker credential." }
  $protected = [System.Security.Cryptography.ProtectedData]::Protect(
    [Text.Encoding]::UTF8.GetBytes($plaintext), $entropy, $scope
  )
  [IO.Directory]::CreateDirectory($storeRoot) | Out-Null
  $temporaryPath = Join-Path $storeRoot ("agent-worker." + [Guid]::NewGuid() + ".tmp")
  try {
    [IO.File]::WriteAllBytes($temporaryPath, $protected)
    Move-Item -LiteralPath $temporaryPath -Destination $storePath -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
  }
  exit 0
}
if (-not (Test-Path -LiteralPath $storePath -PathType Leaf)) {
  throw "The Agent Worker credential does not exist. Pair this device first."
}
$protected = [IO.File]::ReadAllBytes($storePath)
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, $scope)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
