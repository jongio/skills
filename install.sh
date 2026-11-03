#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required to install jongio/skills." >&2
  exit 1
fi

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/scripts/install-plugin.mjs" ]; then
  exec node "$SCRIPT_DIR/scripts/install-plugin.mjs" "$@"
fi

TEMP_ROOT="$(mktemp -d 2>/dev/null || mktemp -d -t 'jongio-skills-install')"
cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

REPO_SLUG="${JONGIO_SKILLS_REPO:-jongio/skills}"
GIT_REF="${JONGIO_SKILLS_REF:-main}"
git clone --depth 1 --branch "$GIT_REF" "https://github.com/$REPO_SLUG.git" "$TEMP_ROOT" --quiet
node "$TEMP_ROOT/scripts/install-plugin.mjs" "$@"
