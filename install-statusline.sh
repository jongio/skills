#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required to install the Copilot CLI statusline." >&2
  exit 1
fi

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/scripts/setup-statusline.mjs" ]; then
  if [ -t 0 ]; then
    exec node "$SCRIPT_DIR/scripts/setup-statusline.mjs" "$@"
  elif [ -e /dev/tty ]; then
    exec node "$SCRIPT_DIR/scripts/setup-statusline.mjs" "$@" </dev/tty
  else
    exec node "$SCRIPT_DIR/scripts/setup-statusline.mjs" "$@"
  fi
fi

TEMP_ROOT="$(mktemp -d 2>/dev/null || mktemp -d -t 'copilot-statusline')"
cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

REPO_SLUG="${COPILOT_STATUSLINE_REPO:-jongio/skills}"
GIT_REF="${COPILOT_STATUSLINE_REF:-main}"
BASE_URL="https://raw.githubusercontent.com/$REPO_SLUG/$GIT_REF"
mkdir -p "$TEMP_ROOT/scripts"
curl -fsSL "$BASE_URL/scripts/setup-statusline.mjs" -o "$TEMP_ROOT/scripts/setup-statusline.mjs"

for file in extension.mjs collector.mjs tracker.mjs github.mjs render.mjs compose.mjs copilot-extension.json; do
  mkdir -p "$TEMP_ROOT/extensions/pr-statusline"
  curl -fsSL "$BASE_URL/extensions/pr-statusline/$file" -o "$TEMP_ROOT/extensions/pr-statusline/$file"
done

for file in extension.mjs tracker.mjs github.mjs render.mjs compose.mjs copilot-extension.json; do
  mkdir -p "$TEMP_ROOT/extensions/issue-statusline"
  curl -fsSL "$BASE_URL/extensions/issue-statusline/$file" -o "$TEMP_ROOT/extensions/issue-statusline/$file"
done

for file in extension.mjs tracker.mjs render.mjs compose.mjs copilot-extension.json; do
  mkdir -p "$TEMP_ROOT/extensions/subagent-statusline"
  curl -fsSL "$BASE_URL/extensions/subagent-statusline/$file" -o "$TEMP_ROOT/extensions/subagent-statusline/$file"
done

for file in extension.mjs tracker.mjs render.mjs compose.mjs copilot-extension.json; do
  mkdir -p "$TEMP_ROOT/extensions/worktree-statusline"
  curl -fsSL "$BASE_URL/extensions/worktree-statusline/$file" -o "$TEMP_ROOT/extensions/worktree-statusline/$file"
done

if [ -t 0 ]; then
  node "$TEMP_ROOT/scripts/setup-statusline.mjs" "$@"
elif [ -e /dev/tty ]; then
  node "$TEMP_ROOT/scripts/setup-statusline.mjs" "$@" </dev/tty
else
  node "$TEMP_ROOT/scripts/setup-statusline.mjs" "$@"
fi
