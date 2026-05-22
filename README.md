# teams plugin

Microsoft Teams chat skill for [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli).

Send messages, read chats, search conversations, reply to threads - all from your terminal.

## Install

### One-liner (copies skill to ~/.copilot/skills/)

```powershell
# PowerShell
gh repo clone jongio/skills $env:TEMP\jongio-skills 2>$null; Copy-Item -Recurse -Force "$env:TEMP\jongio-skills\skills\teams" "$env:USERPROFILE\.copilot\skills\teams"; Remove-Item -Recurse -Force "$env:TEMP\jongio-skills"
```

```sh
# bash/zsh
gh repo clone jongio/skills /tmp/jongio-skills 2>/dev/null && cp -r /tmp/jongio-skills/skills/teams ~/.copilot/skills/teams && rm -rf /tmp/jongio-skills
```

After install, restart Copilot CLI. The skill is available as `/teams`.

### Plugin install (namespaced as /jongio-skills:teams)

```sh
copilot plugin install jongio/skills
```

## Prerequisites

- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az`) - for authentication
- `az login` completed with an account that has Microsoft Graph access
- (Optional) `TEAMS_FLOW_URL` env var - Power Automate flow URL for send fallback if Graph Chat.ReadWrite isn't available

## Operations

| Command | What it does |
|---|---|
| "send {person}: {message}" | Send a 1:1 Teams message |
| "read recent chats" | Show last 20 chats with previews |
| "read unread" | Show chats with unread messages |
| "search teams for {query}" | Search across chat messages |
| "reply to {person}: {message}" | Reply in an existing chat |
| "list teams chats" | List recent conversations |

## How it works

1. **Auth**: Uses `az account get-access-token` for Microsoft Graph API tokens
2. **Backend detection**: Tests Graph `/me/chats` endpoint - if 200, uses Graph for everything. If 403, falls back to Power Automate flow for send operations
3. **UPN resolution**: Resolves display names to UPNs via Graph with a persistent local cache at `~/.config/teams-skill/upn-cache.json`
4. **Safety**: All write operations (send/reply) require explicit user approval before executing

## Setting up Graph permissions

If `az account get-access-token --resource https://graph.microsoft.com/` returns a token but Graph chat endpoints return 403, you need `Chat.ReadWrite` consent. See [docs/setup.md](docs/setup.md) for options.

## Power Automate flow fallback (send-only)

If Graph chat permissions aren't available, set `TEAMS_FLOW_URL` to a Power Automate HTTP trigger that creates a 1:1 chat and posts a message. See [docs/flow-setup.md](docs/flow-setup.md) for step-by-step instructions.

## Configuration

| Item | Location | Purpose |
|---|---|---|
| UPN cache | `~/.config/teams-skill/upn-cache.json` | Display name to UPN mappings |
| Config | `~/.config/teams-skill/config.json` | Optional overrides |
| Flow URL | `TEAMS_FLOW_URL` env var | Power Automate trigger (fallback) |

## License

MIT
