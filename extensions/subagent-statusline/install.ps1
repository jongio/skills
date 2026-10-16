[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$repoSetup = Join-Path $PSScriptRoot '..\..\scripts\setup-statusline.mjs'
if (Test-Path -LiteralPath $repoSetup) {
	& $node $repoSetup --subagents --merge
	if ($LASTEXITCODE -ne 0) { throw "setup-statusline failed with exit code $LASTEXITCODE" }
	exit 0
}
$homeDir = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME '.copilot' }
$target = Join-Path $homeDir 'extensions\subagent-statusline'
$composerPath = Join-Path $homeDir 'statusline-compose.mjs'
New-Item -ItemType Directory -Path $target -Force | Out-Null
foreach ($file in @('extension.mjs', 'tracker.mjs', 'render.mjs', 'compose.mjs', 'copilot-extension.json')) {
	Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $target $file) -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'compose.mjs') -Destination $composerPath -Force
Write-Output "Installed subagent-statusline to $target (composed via $composerPath)."
