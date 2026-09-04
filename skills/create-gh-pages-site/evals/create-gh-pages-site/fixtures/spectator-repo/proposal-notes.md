# Offline cache proposal notes

Current behavior requires network access for every command.

Proposed behavior:

- Cache successful read-only responses for up to 24 hours.
- Never cache credentials or write responses.
- Add `--offline` to require cache-only reads.
- Return a clear error when no eligible entry exists.

Open decision: whether the default storage location should be user-wide or
repository-local.
