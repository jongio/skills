[CmdletBinding()]
param(
	[switch]$All,
	[switch]$Prs,
	[switch]$Issues,
	[switch]$Subagents,
	[switch]$NoPrs,
	[switch]$NoIssues,
	[switch]$NoSubagents
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$node = (Get-Command node -ErrorAction Stop).Source
$forwardArgs = @()
if ($All) { $forwardArgs += '--all' }
if ($Prs) { $forwardArgs += '--prs' }
if ($Issues) { $forwardArgs += '--issues' }
if ($Subagents) { $forwardArgs += '--subagents' }
if ($NoPrs) { $forwardArgs += '--no-prs' }
if ($NoIssues) { $forwardArgs += '--no-issues' }
if ($NoSubagents) { $forwardArgs += '--no-subagents' }

$localSetup = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'scripts\setup-statusline.mjs' } else { $null }
if ($localSetup -and (Test-Path -LiteralPath $localSetup)) {
	& $node $localSetup @forwardArgs
	exit $LASTEXITCODE
}

# Remote one-liner mode (irm .../install-statusline.ps1 | iex): fetch files into temp directory and run setup
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("copilot-statusline-" + [Guid]::NewGuid().ToString('N'))
try {
	$repoSlug = if ($env:COPILOT_STATUSLINE_REPO) { $env:COPILOT_STATUSLINE_REPO } else { 'jongio/skills' }
	$gitRef = if ($env:COPILOT_STATUSLINE_REF) { $env:COPILOT_STATUSLINE_REF } else { 'main' }
	$baseUrl = "https://raw.githubusercontent.com/$repoSlug/$gitRef"
	New-Item -ItemType Directory -Path (Join-Path $tempRoot 'scripts') -Force | Out-Null
	Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/scripts/setup-statusline.mjs" -OutFile (Join-Path $tempRoot 'scripts\setup-statusline.mjs')

	$manifest = @{
		'pr-statusline'       = @('extension.mjs', 'collector.mjs', 'tracker.mjs', 'github.mjs', 'render.mjs', 'compose.mjs', 'copilot-extension.json')
		'issue-statusline'    = @('extension.mjs', 'tracker.mjs', 'github.mjs', 'render.mjs', 'compose.mjs', 'copilot-extension.json')
		'subagent-statusline' = @('extension.mjs', 'tracker.mjs', 'render.mjs', 'compose.mjs', 'copilot-extension.json')
	}
	foreach ($ext in $manifest.Keys) {
		$extDir = Join-Path $tempRoot "extensions\$ext"
		New-Item -ItemType Directory -Path $extDir -Force | Out-Null
		foreach ($file in $manifest[$ext]) {
			Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/extensions/$ext/$file" -OutFile (Join-Path $extDir $file)
		}
	}
	& $node (Join-Path $tempRoot 'scripts\setup-statusline.mjs') @forwardArgs
	if ($LASTEXITCODE -ne 0) { throw "setup-statusline exited with code $LASTEXITCODE" }
} finally {
	Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
