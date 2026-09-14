param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^\d{17,20}$")]
  [string]$ApplicationId
)

$ErrorActionPreference = "Stop"
$clientSecret = (Get-Clipboard -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($clientSecret)) {
  throw "The clipboard does not contain a Discord Client Secret."
}

$storeScript = Join-Path $PSScriptRoot "store-discord-rpc-secret.mjs"
try {
  $clientSecret | & node.exe $storeScript --application-id $ApplicationId
  if ($LASTEXITCODE -ne 0) {
    throw "Discord RPC credential storage failed with exit code $LASTEXITCODE."
  }
} finally {
  # Windows PowerShell 5.1 rejects an empty string as a null clipboard value.
  Set-Clipboard -Value " "
  $clientSecret = $null
}
