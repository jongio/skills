[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot '..\..\scripts\setup-statusline.mjs') --worktrees --merge
if ($LASTEXITCODE -ne 0) { throw "setup-statusline failed with exit code $LASTEXITCODE" }
