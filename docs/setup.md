# Graph API Setup

The Teams skill uses Microsoft Graph API for chat operations. Here's how to ensure you have the right permissions.

## Quick test

```powershell
$token = az account get-access-token --resource https://graph.microsoft.com/ --query accessToken -o tsv
Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/me/chats?`$top=1" `
  -Headers @{ Authorization = "Bearer $token" }
```

If this returns chat data, you're good - full Graph mode works.

If you get a 403, you need to consent to chat permissions.

## Option 1: Use an existing app registration with chat scopes

If your org has an app registration with `Chat.ReadWrite` and `User.Read.All` delegated permissions:

```sh
az login --scope https://graph.microsoft.com/Chat.ReadWrite https://graph.microsoft.com/User.Read.All
```

## Option 2: Register your own Entra ID app

1. Go to [Entra ID App Registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. New registration:
   - Name: `teams-skill` (or whatever you like)
   - Supported account types: Single tenant
   - Redirect URI: `http://localhost` (Mobile and desktop)
3. API permissions → Add:
   - `Microsoft Graph` → Delegated:
     - `Chat.ReadWrite` (send/create chats)
     - `Chat.Read` (read chats - alternative to ReadWrite)
     - `User.Read.All` (resolve display names to UPNs)
     - `User.Read` (basic profile)
4. Grant admin consent (or ask your tenant admin)
5. Use the app:

```sh
az login --tenant YOUR_TENANT_ID --scope https://graph.microsoft.com/.default
```

## Option 3: Flow-only mode (no Graph chat permissions needed)

If you can't get chat permissions, set `TEAMS_FLOW_URL` and the skill will:
- Use the flow for **send** operations
- Inform you that **read/search** aren't available without Graph

See [flow-setup.md](flow-setup.md) for how to create the flow.

## Permission summary

| Operation | Required scope |
|---|---|
| list-chats | `Chat.Read` or `Chat.ReadWrite` |
| read-recent | `Chat.Read` or `Chat.ReadWrite` |
| read-unread | `Chat.Read` or `Chat.ReadWrite` |
| search | `Chat.Read` or `Chat.ReadWrite` |
| send | `Chat.ReadWrite` (or `TEAMS_FLOW_URL` fallback) |
| reply | `Chat.ReadWrite` (or `TEAMS_FLOW_URL` fallback) |
| UPN lookup | `User.Read.All` |
