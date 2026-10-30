[CmdletBinding()]
param(
	[switch]$All,
	[switch]$Prs,
	[switch]$Issues,
	[switch]$Subagents,
	[switch]$Worktrees,
	[switch]$NoPrs,
	[switch]$NoIssues,
	[switch]$NoSubagents,
	[switch]$NoWorktrees,
	[switch]$Notifications
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$node = (Get-Command node -ErrorAction Stop).Source
$forwardArgs = @()
if ($All) { $forwardArgs += '--all' }
if ($Prs) { $forwardArgs += '--prs' }
if ($Issues) { $forwardArgs += '--issues' }
if ($Subagents) { $forwardArgs += '--subagents' }
if ($Worktrees) { $forwardArgs += '--worktrees' }
if ($NoPrs) { $forwardArgs += '--no-prs' }
if ($NoIssues) { $forwardArgs += '--no-issues' }
if ($NoSubagents) { $forwardArgs += '--no-subagents' }
if ($NoWorktrees) { $forwardArgs += '--no-worktrees' }
if ($Notifications) { $forwardArgs += '--notifications' }

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
	New-Item -ItemType Directory -Path (Join-Path $tempRoot 'extensions') -Force | Out-Null
	foreach ($file in @('state-lock.mjs', 'github-client.mjs', 'github-client.LICENSE', 'github-transport.mjs', 'github-refresh.mjs', 'refresh-github.mjs')) {
		Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/extensions/$file" -OutFile (Join-Path $tempRoot "extensions\$file")
	}
	New-Item -ItemType Directory -Path (Join-Path $tempRoot 'extensions\daemon-notifications') -Force | Out-Null
	foreach ($file in @('extension.mjs', 'bridge.mjs')) {
		Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/extensions/daemon-notifications/$file" -OutFile (Join-Path $tempRoot "extensions\daemon-notifications\$file")
	}

	$manifest = @{
		'pr-statusline'       = @('extension.mjs', 'collector.mjs', 'session-statusline.mjs', 'tracker.mjs', 'github.mjs', 'provenance.mjs', 'lifecycle.mjs', 'render.mjs', 'compose.mjs', 'attention.mjs', 'attention-state.mjs', 'attention.windows.cs', 'copilot-extension.json')
		'issue-statusline'    = @('extension.mjs', 'tracker.mjs', 'github.mjs', 'render.mjs', 'compose.mjs', 'copilot-extension.json')
		'subagent-statusline' = @('extension.mjs', 'tracker.mjs', 'settlement.mjs', 'render.mjs', 'compose.mjs', 'copilot-extension.json')
		'worktree-statusline' = @('extension.mjs', 'tracker.mjs', 'render.mjs', 'grouping.mjs', 'worktrees.mjs', 'compose.mjs', 'copilot-extension.json')
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
