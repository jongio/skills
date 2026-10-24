# Daemon notifications

Optional Copilot SDK timeline integration for CI/PR watcher events. The extension
uses the current host session's `joinSession()` and `session.log()`. It never
creates another Copilot runtime, calls a model, starts watchers or repairs, or
authorizes a merge.

The full plugin and standalone statuslines plugin expose this entry point.
Subscription is disabled until explicitly requested. For a manual install, run
from the repository root:

```powershell
node scripts\setup-statusline.mjs --notifications
```

This preserves the current footer selection. Restart Copilot to discover newly
installed extension files, then subscribe:

```text
/daemon-notifications subscribe ci
```

Use the returned session-local file with the existing daemon command:

```powershell
node skills\ci-hound\scripts\ci-hound-daemon.mjs watch --events-file "<returned-file>"
```

Use a distinct watcher identifier/file for each daemon process. The PR watcher
accepts the same flag. `/daemon-notifications status` lists subscriptions;
`/daemon-notifications unsubscribe ci` disables one subscription.

Normal stdout, desktop failure alerts, host completion wake-ups, and re-arming
remain unchanged. A timeline message is not proof that an agent woke up.
Repeated unchanged progress is coalesced per target, with at most 128 retained
target watermarks per subscription. Unrelated repositories, PRs, runs, and heads
do not suppress each other's first update. Completed records are deduplicated on
restart, partial/malformed records are ignored, and event storage is bounded.
Delivery is not exactly-once across a crash between logging and acknowledgment.
Disabling the bridge does not stop a watcher; stop it through its owning host.
