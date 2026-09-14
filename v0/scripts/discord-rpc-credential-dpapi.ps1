$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Security

$Action = if ($args.Count -gt 0) {
  $args[0]
} else {
  $env:PERSONAL_CONTEXT_DPAPI_ACTION
}
if (@("read", "write", "path") -notcontains $Action) {
  throw "Action must be read, write, or path."
}

$storeRoot = if ($env:PERSONAL_CONTEXT_DPAPI_DIR) {
  $env:PERSONAL_CONTEXT_DPAPI_DIR
} else {
  Join-Path $env:LOCALAPPDATA "personal-context-hub"
}
$storePath = Join-Path $storeRoot "discord-rpc.dpapi"
$entropy = [Text.Encoding]::UTF8.GetBytes("personal-context-hub/discord-rpc/v1")
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser

if ($Action -eq "path") {
  [Console]::Out.Write($storePath)
  exit 0
}

if ($Action -eq "write") {
  $plaintext = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($plaintext)) {
    throw "Refusing to store an empty Discord RPC credential."
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes($plaintext)
  $protected = [System.Security.Cryptography.ProtectedData]::Protect(
    $bytes,
    $entropy,
    $scope
  )
  [IO.Directory]::CreateDirectory($storeRoot) | Out-Null
  $temporaryPath = Join-Path $storeRoot ("discord-rpc." + [Guid]::NewGuid() + ".tmp")
  try {
    [IO.File]::WriteAllBytes($temporaryPath, $protected)
    Move-Item -LiteralPath $temporaryPath -Destination $storePath -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $storePath -PathType Leaf)) {
  throw "The Windows DPAPI Discord RPC credential does not exist."
}
$protected = [IO.File]::ReadAllBytes($storePath)
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $protected,
  $entropy,
  $scope
)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
