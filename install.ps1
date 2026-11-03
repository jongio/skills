[CmdletBinding()]
param(
	[string[]]$Platform,
	[switch]$CleanOnly,
	[switch]$DryRun,
	[switch]$Json,
	[switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$node = (Get-Command node -ErrorAction Stop).Source
$forwardArgs = @()
if ($Platform) {
	foreach ($p in $Platform) { $forwardArgs += @('--platform', $p) }
}
if ($CleanOnly) { $forwardArgs += '--clean-only' }
if ($DryRun) { $forwardArgs += '--dry-run' }
if ($Json) { $forwardArgs += '--json' }
if ($Help) { $forwardArgs += '--help' }

$localScript = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'scripts\install-plugin.mjs' } else { $null }
if ($localScript -and (Test-Path -LiteralPath $localScript)) {
	& $node $localScript @forwardArgs
	exit $LASTEXITCODE
}

# Remote one-liner mode (irm https://raw.githubusercontent.com/jongio/skills/main/install.ps1 | iex)
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("jongio-skills-install-" + [Guid]::NewGuid().ToString('N'))
try {
	$repoSlug = if ($env:JONGIO_SKILLS_REPO) { $env:JONGIO_SKILLS_REPO } else { 'jongio/skills' }
	$gitRef = if ($env:JONGIO_SKILLS_REF) { $env:JONGIO_SKILLS_REF } else { 'main' }
	git clone --depth 1 --branch $gitRef "https://github.com/$repoSlug.git" $tempRoot --quiet
	& $node (Join-Path $tempRoot 'scripts\install-plugin.mjs') @forwardArgs
	if ($LASTEXITCODE -ne 0) { throw "install-plugin exited with code $LASTEXITCODE" }
} finally {
	Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
