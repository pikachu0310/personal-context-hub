$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
try {
    $projectDirectory = if ($env:IDO_AGENT_PROJECT_DIRECTORY) { (Resolve-Path -LiteralPath $env:IDO_AGENT_PROJECT_DIRECTORY).Path } else { (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path }
    if ($projectDirectory.StartsWith('\\')) {
        throw 'Copy or clone this project into a Windows folder before opening Start Agent.cmd.'
    }
    Set-Location -LiteralPath $projectDirectory
    function Refresh-AgentPath {
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
    }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodeOkay = $node -and ([int]((& $node.Source --version).TrimStart('v').Split('.')[0]) -ge 22)
    $gitOkay = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $nodeOkay -or -not $gitOkay) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if (-not $winget) { throw 'Install Node.js 22+ (nodejs.org) and Git (git-scm.com), then reopen this file. Windows App Installer can prepare these automatically when winget is available.' }
        $answer = [System.Windows.Forms.MessageBox]::Show('This connection app needs Node.js 22+ and Git. Install the missing programs using Windows Package Manager? You may see installer and license prompts.', 'Agent setup', 'YesNo', 'Question')
        if ($answer -ne 'Yes') { return }
        if (-not $nodeOkay) {
            & $winget.Source install --id OpenJS.NodeJS.LTS --exact --source winget --interactive
            if ($LASTEXITCODE -ne 0) { throw 'Node.js installation did not complete. Reopen this file after installation.' }
        }
        if (-not $gitOkay) {
            & $winget.Source install --id Git.Git --exact --source winget --interactive
            if ($LASTEXITCODE -ne 0) { throw 'Git installation did not complete. Reopen this file after installation.' }
        }
        Refresh-AgentPath
    }
    $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
    $nodeVersion = & $nodeExecutable --version
    if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) {
        throw 'Install Node.js 22 or later, then reopen Start Agent.cmd.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory 'node_modules\@openai\codex\package.json'))) {
        & npm.cmd ci --omit=dev
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check your internet connection and try again.' }
    }
    Start-Process -FilePath $nodeExecutable -ArgumentList 'scripts/discord-agent-ui.mjs' -WorkingDirectory $projectDirectory -WindowStyle Hidden
} catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Agent setup', 'OK', 'Error') | Out-Null
}
