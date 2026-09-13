$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
try {
    $projectDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
    if ($projectDirectory.StartsWith('\\')) {
        throw 'Copy or clone this project into a Windows folder before opening Start Agent.cmd.'
    }
    Set-Location -LiteralPath $projectDirectory
    $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
    $nodeVersion = & $nodeExecutable --version
    if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) {
        throw 'Install Node.js 22 or later, then reopen Start Agent.cmd.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory 'node_modules\@openai\codex\package.json'))) {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check your internet connection and try again.' }
    }
    Start-Process -FilePath $nodeExecutable -ArgumentList 'scripts/discord-agent-ui.mjs' -WorkingDirectory $projectDirectory -WindowStyle Hidden
} catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Agent setup', 'OK', 'Error') | Out-Null
}
