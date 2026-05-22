# Power Automate Flow Setup (Send Fallback)

If Graph `Chat.ReadWrite` isn't available in your tenant, you can use a Power Automate flow as the send backend. This only supports **send** - read/search still require Graph permissions.

## What the flow does

1. Receives an HTTP POST with `{ "recipient": "upn@domain.com", "message": "text" }`
2. Creates a 1:1 chat with the recipient
3. Posts the message to that chat (as you)

## Create the flow

1. Go to [Power Automate](https://make.powerautomate.com/)
2. Create → Instant cloud flow → Skip the trigger selection
3. Add trigger: **When an HTTP request is received**
   - Method: POST
   - Request body JSON schema:
     ```json
     {
       "type": "object",
       "properties": {
         "recipient": { "type": "string" },
         "message": { "type": "string" }
       },
       "required": ["recipient", "message"]
     }
     ```

4. Add action: **Microsoft Teams → Create a chat** (V1)
   - Members: Select the `recipient` dynamic value from the trigger

5. Add action: **Microsoft Teams → Post message in a chat or channel**
   - Post as: **User** (important - shows as you, not Flow bot)
   - Post in: **Chat with Flow bot** → switch to custom value → use the Chat ID from step 4
   - Message: Select the `message` dynamic value from the trigger

6. Save the flow

## Get the flow trigger URL

### Option A: From the flow designer

Click on the HTTP trigger step → copy the URL shown.

### Option B: Via API (if you manage the flow programmatically)

```powershell
$token = az account get-access-token --resource https://service.flow.microsoft.com/ --query accessToken -o tsv
# List your flows
Invoke-RestMethod -Uri "https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments/{env-id}/flows?api-version=2016-11-01" `
  -Headers @{ Authorization = "Bearer $token" }
```

## Configure the skill

Set the environment variable:

```sh
# PowerShell
$env:TEAMS_FLOW_URL = "https://your-environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/YOUR_WORKFLOW_ID/triggers/manual/paths/invoke?api-version=1"

# Or add to your shell profile for persistence
# ~/.bashrc, ~/.zshrc, or PowerShell $PROFILE
```

## Authentication

The flow URL hosted on `*.powerplatform.com` requires a Bearer token:

```powershell
$token = az account get-access-token --resource https://service.flow.microsoft.com/ --query accessToken -o tsv
```

If your flow URL is on `*.logic.azure.com` (Logic Apps style with SAS token in URL), set:

```sh
TEAMS_FLOW_AUTH=sas
```

This tells the skill to skip the Bearer token and just POST directly.

## Test it

```powershell
$token = az account get-access-token --resource https://service.flow.microsoft.com/ --query accessToken -o tsv
$body = @{ recipient = "colleague@yourdomain.com"; message = "Test from teams skill" } | ConvertTo-Json
Invoke-WebRequest -Uri $env:TEAMS_FLOW_URL -Method POST `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body $body -UseBasicParsing
```

Expected: HTTP 202 Accepted. The message appears in Teams within seconds.

## Troubleshooting

| Issue | Fix |
|---|---|
| 401 Unauthorized | Token expired - re-run `az account get-access-token` |
| 400 TriggerInputSchemaMismatch | Flow expects different field names - check schema matches `recipient`/`message` |
| Flow is suspended | Re-enable at make.powerautomate.com or via API |
| Message shows as "Flow bot" | Change "Post as" to "User" in the Post message action |
| Wrong recipient | Verify UPN is correct (use Graph to look up `userPrincipalName`, not `mail`) |
