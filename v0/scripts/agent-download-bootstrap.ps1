$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
try {
    $source = [IO.File]::ReadAllText($env:IDO_AGENT_SETUP_FILE)
    $match = [regex]::Match($source, '(?m)^::IDO_PAYLOAD:([A-Za-z0-9+/=]+)\r?$')
    if (-not $match.Success) { throw 'Setup file is incomplete. Download Connect-Agent.cmd again from Discord.' }
    $bytes = [Convert]::FromBase64String($match.Groups[1].Value)
    $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    if ($hash -ne '__PAYLOAD_SHA256__') { throw 'Setup file integrity check failed. Download it again.' }
    $installRoot = Join-Path $env:LOCALAPPDATA ('personal-context-hub\agent-client\' + $hash)
    $inputStream = [IO.MemoryStream]::new($bytes, $false)
    $gzip = [IO.Compression.GZipStream]::new($inputStream, [IO.Compression.CompressionMode]::Decompress)
    $reader = [IO.StreamReader]::new($gzip, [Text.Encoding]::UTF8)
    try { $files = ConvertFrom-Json $reader.ReadToEnd() } finally { $reader.Dispose(); $gzip.Dispose(); $inputStream.Dispose() }
    $root = [IO.Path]::GetFullPath($installRoot) + [IO.Path]::DirectorySeparatorChar
    function Assert-AgentRealPath([string]$path) {
        while ($path) {
            if (Test-Path -LiteralPath $path) {
                if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Setup path must not contain links.' }
            }
            $path = [IO.Path]::GetDirectoryName($path)
        }
    }
    foreach ($file in $files) {
        if ($file.name -notmatch '^(?:(src|scripts)/[a-zA-Z0-9_./-]+\.(mjs|js|html|ps1)|package(-lock)?\.json|Start Agent\.cmd)$' -or $file.name.Split('/') -contains '..') { throw 'Unsafe setup path.' }
        $target = [IO.Path]::GetFullPath((Join-Path $installRoot $file.name))
        if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe setup path.' }
        $directory = [IO.Path]::GetDirectoryName($target)
        Assert-AgentRealPath $target
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        Assert-AgentRealPath $target
        [IO.File]::WriteAllBytes($target, [Convert]::FromBase64String($file.data))
    }
    $env:IDO_AGENT_PROJECT_DIRECTORY = $installRoot
    & ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path $installRoot 'scripts\start-agent-ui.ps1'))))
} catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Agent setup', 'OK', 'Error') | Out-Null
    exit 1
}
