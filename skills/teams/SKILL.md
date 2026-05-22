---
name: teams
description: Full Teams chat skill - send, read, search, reply, summarize. Adaptive backend (Graph API or Power Automate flow fallback). Requires az CLI for auth.
---

# Teams

Full-lifecycle Teams chat skill: send messages, read recent/unread chats, search conversations, reply to threads, list chats, and summarize a thread. Uses Microsoft Graph API with automatic fallback to Power Automate flow for send when Graph chat permissions aren't available.

## When to Use

- "Send {person} a message: {text}"
- "Read my recent Teams chats"
- "What unread Teams messages do I have?"
- "Search Teams for {query}"
- "Reply to {person}: {text}"
- "List my Teams chats"
- "Summarize this Teams chat: {link}" / "Catch me up on the {chat name} chat"
- Any request involving Teams chat reading, sending, searching, replying, or summarizing.

## Operations (choices)

This skill exposes a fixed set of operations, modeled after the runtime's `/skills <subcommand>` pattern (one canonical verb, then verb-specific args). The full list:

```
choices: ["send", "list-chats", "read-recent", "read-unread", "search", "reply", "summarize"]
```

Unknown verb → print the help block in the "Unknown operation" section at the bottom of this file. Never silently guess.

## Configuration

### Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `TEAMS_FLOW_URL` | No | Power Automate flow trigger URL (fallback for send if Graph Chat.ReadWrite unavailable) |
| `TEAMS_FLOW_AUTH` | No | Auth mode for flow: `bearer` (default) or `sas` (URL contains SAS token) |

### Files

| Path | Purpose |
|---|---|
| `~/.config/teams-skill/upn-cache.json` | Persistent display-name → UPN cache |
| `~/.config/teams-skill/config.json` | Optional config overrides |

## Instructions

### Step 0 — Authenticate and detect backend

Get a Graph token:

```powershell
$graphToken = az account get-access-token --resource https://graph.microsoft.com/ --query accessToken -o tsv
```

Test chat access:

```powershell
$test = Invoke-WebRequest -Uri "https://graph.microsoft.com/v1.0/me/chats?`$top=1" `
  -Headers @{ Authorization = "Bearer $graphToken" } -UseBasicParsing -SkipHttpErrorCheck
$graphChatAvailable = $test.StatusCode -eq 200
```

**Backend modes:**
- **graph-full**: Graph returns 200 on `/me/chats` → all operations via Graph
- **graph-read-flow-send**: Graph reads work but send fails (Chat.Read but not Chat.ReadWrite) → read via Graph, send via flow
- **flow-only**: Graph chat endpoints return 403 → send via `TEAMS_FLOW_URL`, read not available (inform user)

If flow-only and `TEAMS_FLOW_URL` is not set, inform the user they need either:
1. Graph Chat permissions (see setup.md), OR
2. A Power Automate flow URL in `TEAMS_FLOW_URL`

### Step 1 — Route the operation

Parse the user's request to determine the operation:

| Intent | Operation |
|---|---|
| send/message/tell/ping someone | `send` |
| read recent, latest messages | `read-recent` |
| unread, missed, what did I miss | `read-unread` |
| search/find/look for in chats | `search` |
| reply to, respond to | `reply` |
| list chats, who messaged me | `list-chats` |
| summarize, catch me up on, ramp me up on, what's the thread about | `summarize` |

---

## Operations

### send

Send a 1:1 chat message to a colleague by display name.

**Step 1 — Resolve recipient to UPN** (see "UPN Resolution" section below)

**Step 2 — Pre-action approval (MANDATORY)**

Present via `ask_user`:
```
Teams Send:
  To: {Display Name} ({UPN})
  Message: "{message text}"

Send this?
```

**Never skip approval. Never auto-send.**

**Step 3a — Send via Graph** (if graph-full)

```powershell
# Create or get existing 1:1 chat
$chatBody = @{
  chatType = "oneOnOne"
  members = @(
    @{ "@odata.type" = "#microsoft.graph.aadUserConversationMember"; roles = @("owner"); "user@odata.bind" = "https://graph.microsoft.com/v1.0/users/$myUpn" },
    @{ "@odata.type" = "#microsoft.graph.aadUserConversationMember"; roles = @("owner"); "user@odata.bind" = "https://graph.microsoft.com/v1.0/users/$recipientUpn" }
  )
} | ConvertTo-Json -Depth 5

$chat = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/chats" `
  -Method POST -Headers @{ Authorization = "Bearer $graphToken"; "Content-Type" = "application/json" } `
  -Body $chatBody

# Send message
$msgBody = @{ body = @{ content = "$message" } } | ConvertTo-Json -Depth 3
Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/chats/$($chat.id)/messages" `
  -Method POST -Headers @{ Authorization = "Bearer $graphToken"; "Content-Type" = "application/json" } `
  -Body $msgBody
```

**Step 3b — Send via Flow** (fallback)

```powershell
$flowToken = az account get-access-token --resource https://service.flow.microsoft.com/ --query accessToken -o tsv
$body = @{ recipient = "$recipientUpn"; message = "$message" } | ConvertTo-Json
$headers = @{ Authorization = "Bearer $flowToken"; "Content-Type" = "application/json" }
Invoke-WebRequest -Uri $env:TEAMS_FLOW_URL -Method POST -Headers $headers -Body $body -UseBasicParsing
```

Expected: HTTP 202 = success.

---

### list-chats

List recent chats with last message preview.

```powershell
$resp = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/me/chats?`$expand=lastMessagePreview&`$top=20&`$orderby=lastMessagePreview/createdDateTime desc" `
  -Headers @{ Authorization = "Bearer $graphToken" }
```

Display as:
```
Recent Teams Chats:
1. {display name or chat topic} — "{last message preview}" — {relative time}
2. ...
```

---

### read-recent

Read recent messages from a specific chat (by person name or chat selection).

**Step 1** — If person specified, resolve to UPN, then find their chat:

```powershell
$chats = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/me/chats?`$expand=members&`$top=50" `
  -Headers @{ Authorization = "Bearer $graphToken" }
# Find chat where members includes the target UPN
$chatId = ($chats.value | Where-Object { $_.members.email -contains $recipientUpn -or $_.members.userId -ne $null }).id
```

**Step 2** — Fetch messages:

```powershell
$msgs = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/me/chats/$chatId/messages?`$top=10&`$orderby=createdDateTime desc" `
  -Headers @{ Authorization = "Bearer $graphToken" }
```

**Step 3** — Display:
```
Chat with {name} — last 10 messages:
[{time}] {sender}: {content}
...
```

---

### read-unread

Show chats with unread messages.

```powershell
$chats = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/me/chats?`$expand=lastMessagePreview&`$top=50&`$filter=viewpoint/lastMessageReadDateTime lt lastMessagePreview/createdDateTime" `
  -Headers @{ Authorization = "Bearer $graphToken" }
```

If the `$filter` isn't supported, fall back to fetching all chats and comparing `viewpoint.lastMessageReadDateTime` with `lastMessagePreview.createdDateTime` client-side.

Display unread chats with message count and preview.

---

### search

Search across chat messages for a keyword/phrase.

```powershell
# Use beta endpoint for cross-chat search
$encoded = [Uri]::EscapeDataString($query)
$results = Invoke-RestMethod -Uri "https://graph.microsoft.com/beta/me/chats/getAllMessages?`$search=`"$encoded`"&`$top=25" `
  -Headers @{ Authorization = "Bearer $graphToken" }
```

If beta not available or returns 403, fall back to searching recent chats individually:

```powershell
# Get recent chats, then search messages in each
$chats = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/me/chats?`$top=10" -Headers @{ Authorization = "Bearer $graphToken" }
foreach ($chat in $chats.value) {
  $msgs = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/me/chats/$($chat.id)/messages?`$top=50" -Headers @{ Authorization = "Bearer $graphToken" }
  # Client-side filter for $query in body.content
}
```

Display matches with chat context, sender, time, and content snippet.

---

### reply

Reply to a message in an existing chat. Same as `send` but targets an existing chat by person name (no need to create a new chat).

**Step 1** — Resolve person → UPN → find existing chat ID (same as read-recent Step 1)

**Step 2** — Pre-action approval (MANDATORY) via `ask_user`

**Step 3** — Post message to existing chat:

```powershell
$msgBody = @{ body = @{ content = "$message" } } | ConvertTo-Json -Depth 3
Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/me/chats/$chatId/messages" `
  -Method POST -Headers @{ Authorization = "Bearer $graphToken"; "Content-Type" = "application/json" } `
  -Body $msgBody
```

---

### summarize

Produce a ramp-up brief for a Teams chat or thread. Read-only.

**Input** — accept either:

- **A Teams deep link**: `msteams:/l/message/19:<thread-id>@thread.v2/<message-id>?context=...` or the `https://teams.microsoft.com/l/message/...` equivalent.
- **A freeform context phrase**: chat title fragment, participant name, or a phrase from a message.

**Step 1 — Resolve to a chat ID**

Link path (preferred — deterministic):

```powershell
if ($input -match 'message/(19[:%3A][^/]+@thread\.v2)/(\d+)') {
    $chatId = [Uri]::UnescapeDataString($Matches[1])  # decode %3A -> :
    $msgId  = $Matches[2]
}
```

Phrase path:

```powershell
$chats = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/me/chats?`$expand=members,lastMessagePreview&`$top=50&`$orderby=lastMessagePreview/createdDateTime desc" -Headers @{ Authorization = "Bearer $graphToken" }
$matches = $chats.value | Where-Object {
    ($_.topic -and $_.topic -match [Regex]::Escape($query)) -or
    ($_.members.displayName -join ' ') -match [Regex]::Escape($query)
}
# Fallback: body search across chats
if (-not $matches) {
    $encoded = [Uri]::EscapeDataString($query)
    $search = Invoke-RestMethod -Uri "https://graph.microsoft.com/beta/me/chats/getAllMessages?`$search=`"$encoded`"&`$top=25" -Headers @{ Authorization = "Bearer $graphToken" }
}
```

If >1 chat matches, present candidates via `ask_user` (topic, members, last message time). Never silently pick.

**Step 2 — Fetch full thread + roster**

```powershell
$all = @()
$url = "https://graph.microsoft.com/v1.0/me/chats/$chatId/messages?`$top=50&`$orderby=createdDateTime desc"
while ($url) {
    $page = Invoke-RestMethod -Uri $url -Headers @{ Authorization = "Bearer $graphToken" }
    $all += $page.value
    $url  = $page.'@odata.nextLink'
    if ($all.Count -ge 500) { break }   # hard cap; mention truncation in output
}
[Array]::Reverse($all)
$members = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/me/chats/$chatId/members" -Headers @{ Authorization = "Bearer $graphToken" }
$me = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/me" -Headers @{ Authorization = "Bearer $graphToken" }
```

**Step 3 — Normalize messages**

- Skip messages where `messageType -ne 'message'` (drop `systemEventMessage` unless it's an add/remove worth noting).
- When `body.contentType -eq 'html'`, strip HTML but preserve `@mentions` (`<at id="...">Name</at>` → `@Name`) and links (`<a href="X">Y</a>` → `Y (X)` if `X != Y`).
- Capture: `createdDateTime`, `from.user.displayName` (fallback `from.application.displayName` with `[bot]` prefix), normalized text, attachment names, reactions.

Helper:

```powershell
function Strip-TeamsHtml([string]$html) {
    if (-not $html) { return '' }
    $t = $html
    $t = [Regex]::Replace($t, '<at[^>]*>([^<]+)</at>', '@$1')
    $t = [Regex]::Replace($t, '<a [^>]*href="([^"]+)"[^>]*>([^<]+)</a>', { param($m) if ($m.Groups[1].Value -eq $m.Groups[2].Value) { $m.Groups[2].Value } else { "$($m.Groups[2].Value) ($($m.Groups[1].Value))" } })
    $t = [Regex]::Replace($t, '<br\s*/?>', "`n")
    $t = [Regex]::Replace($t, '</p>', "`n")
    $t = [Regex]::Replace($t, '<[^>]+>', '')
    $t = [System.Net.WebUtility]::HtmlDecode($t)
    return ($t -replace "`n{3,}", "`n`n").Trim()
}
```

**Step 4 — Compose the brief** (exact structure):

```
# {chat topic or "Chat with {participants}"}

**Participants** ({n}): {Name1}, {Name2}, ...
**Span:** {first message date} → {last message date}  ·  **{N} messages**
**Open in Teams:** {deep link}

## TL;DR
{2–4 sentence factual summary of what this chat is about, why it exists, and current state.}

## Timeline
- **{date}** — {one-line summary of that day/burst, who drove it}

## Decisions
- {decision} — {who, when}
(omit section if none)

## Open threads / unanswered
- {question or hanging item} — {who asked, when}

## Action items for {me}
- [ ] {action} — {context} — {due if stated}
(if none: "Nothing waiting on you.")

## Full thread (chronological)
[{YYYY-MM-DD HH:mm}] **{Sender}**: {text}
```

Rules:
- "me" = the `$me.id` user. Action items only when there's an explicit ask directed at the user, an @mention with a verb, or an unanswered question after the user's last message.
- TL;DR is factual — no speculation. If the thread is thin, say so.
- Use the provided link if any; else synthesize `https://teams.microsoft.com/l/chat/{chatId}/conversations`.

**Step 5 — Offer follow-ups** (one line):

> Want me to draft a reply (via `teams reply`), pull a specific person's messages, or expand any section?

Never auto-draft. The `summarize` operation is read-only — any write hands off to `send` or `reply`.

**Edge cases:**

| Situation | Handling |
|---|---|
| Channel link (`@thread.tacv2` / `@thread.skype`) | Try `/teams/{teamId}/channels/{channelId}/messages` from context; otherwise tell user channel summarization isn't supported and offer search fallback. |
| 500+ messages | Summarize most recent 500; call out the truncation. |
| 403 on `/me/chats` | Tell user `Chat.Read` consent is missing (see `docs/setup.md`). Don't degrade silently. |
| Meeting chat (`19:meeting_...`) | Works as a normal group chat via the same endpoint. |
| Bot/app messages | Include with `[bot] {AppName}` label. |
| Reactions | Don't expand inline; mention in TL;DR only if signal is high. |
| Multiple matches | `ask_user` to disambiguate. |
| User not a member of the chat | Graph returns 404 — surface it, don't work around it. |

---

## Unknown operation

If the parsed operation isn't in the `choices` list above, print this help block instead of guessing:

```
Teams skill usage:
  send {person}: {text}            — Send a 1:1 message (requires approval)
  reply to {person}: {text}        — Reply in an existing chat (requires approval)
  list-chats                       — Show recent chats with previews
  read-recent [{person}]           — Show last 10 messages from a chat
  read-unread                      — Show chats with unread messages
  search {query}                   — Search across chat messages
  summarize {link | phrase}        — Ramp-up brief for a chat or thread (read-only)
```

---

## UPN Resolution

Shared logic for all operations that need a person's UPN.

### Cache check

```powershell
$cachePath = "$env:USERPROFILE/.config/teams-skill/upn-cache.json"
if (Test-Path $cachePath) {
  $cache = Get-Content $cachePath -Raw | ConvertFrom-Json
  $upn = $cache."$($name.ToLower())"
}
```

### Graph lookup (cache miss)

```powershell
$graphToken = az account get-access-token --resource https://graph.microsoft.com/ --query accessToken -o tsv
$encoded = [Uri]::EscapeDataString("displayName:$name")
$resp = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/users?`$filter=startswith(displayName,'$name')&`$select=userPrincipalName,displayName,mail" `
  -Headers @{ Authorization = "Bearer $graphToken" }
```

Pick closest match. If zero results, try `$search="displayName:$name"` (requires ConsistencyLevel: eventual header). If still zero, ask user for UPN directly.

### Cache write

```powershell
$dir = "$env:USERPROFILE/.config/teams-skill"
if (-not (Test-Path $dir)) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }
$cache = if (Test-Path $cachePath) { Get-Content $cachePath -Raw | ConvertFrom-Json } else { [PSCustomObject]@{} }
$cache | Add-Member -NotePropertyName "$($name.ToLower())" -NotePropertyValue "$upn" -Force
$cache | ConvertTo-Json | Set-Content $cachePath
```

## Error Handling

| Status | Meaning | Action |
|---|---|---|
| 401 | Token expired | Re-run `az account get-access-token` and retry |
| 403 | Insufficient permissions | Switch to flow fallback for send; inform user for read ops |
| 404 | Chat/user not found | Verify UPN, ask user |
| 429 | Rate limited | Wait `Retry-After` seconds and retry |
| 400 (TriggerInputSchemaMismatch) | Flow schema changed | Check flow input field names |

## Required Tools

| Tool | Purpose |
|---|---|
| `az` CLI | Get access tokens for Graph API and Power Automate |
| `Invoke-RestMethod` / `curl` | API calls |
| `ask_user` | Pre-send/reply approval gate |

## Safety Rules

- **Never auto-send or auto-reply.** Every write operation requires explicit `ask_user` approval.
- **Read operations are always allowed** without approval.
- **Never log full tokens** in output. Show only last 4 chars if debugging.
- **UPN cache is local only.** Never transmit cached data externally.

## Tips

- If Graph token doesn't have chat permissions, the skill degrades gracefully to send-only (via flow) and informs the user what's missing.
- UPN resolution is shared across all operations — the cache builds up over time regardless of which operation triggered the lookup.
- For Microsoft orgs: `userPrincipalName` often differs from `mail` (e.g., `shboyer@microsoft.com` vs `shayne.boyer@microsoft.com`). Always use `userPrincipalName`.
- If the user provides a UPN directly (contains `@`), skip Graph lookup and cache it.
- For batch operations (send to multiple people), process each recipient separately with individual approvals.
