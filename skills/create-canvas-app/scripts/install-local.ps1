# scripts/install-local.ps1
# Install this skill into the local Copilot CLI skills directory so the agent
# can use it immediately (no npm, no network). Re-run after editing SKILL.md.
#
#   pwsh -File scripts/install-local.ps1
#
# Override the destination with -SkillsDir or the COPILOT_HOME env var.

[CmdletBinding()]
param(
    [string]$SkillsDir
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$skillName = "create-canvas-app"

if (-not $SkillsDir) {
    $copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE ".copilot" }
    $SkillsDir = Join-Path $copilotHome "skills"
}

$dest = Join-Path $SkillsDir $skillName
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Mirror the repo into the skill folder, excluding VCS + local state.
robocopy $repoRoot $dest /MIR /XD ".git" "artifacts" "node_modules" "vally-results" /XF ".gitignore" "package-lock.json" /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "install failed (robocopy exit $LASTEXITCODE)" }

Write-Host "Installed '$skillName' skill to: $dest"
Write-Host "Reload skills (restart the CLI or run '/skills reload') to pick it up."
