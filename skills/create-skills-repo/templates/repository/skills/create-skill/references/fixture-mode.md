# Fixture mode

Fixture mode gives repository generators one stable noninteractive path for creating a functional
example skill. It uses the same renderer, registration planner, PNG validator, and atomic apply as
normal authoring.

## Commands

Preview:

```text
node scripts/create-skill.mjs fixture \
  --input "<fixture.json>" \
  --repo-root "<target-repository>" \
  --dry-run
```

Apply:

```text
node scripts/create-skill.mjs fixture \
  --input "<fixture.json>" \
  --repo-root "<target-repository>" \
  --approve "<preview-hash>"
```

`--input` may be absolute or relative to the caller's working directory. `--repo-root` may be
absolute or relative to that same directory. Fixture mode takes no positional name and needs no
`--non-interactive` flag.

## Version 1 payload

```json
{
  "schemaVersion": 1,
  "name": "example-skill",
  "title": "Example Skill",
  "description": "A functional example that verifies portable skill distribution.",
  "routing": {
    "type": "utility",
    "useFor": [
      "run the example skill",
      "verify the skills repository"
    ],
    "doNotUseFor": [
      "authoring a new skill"
    ]
  },
  "behavior": {
    "purpose": "Return a repository health confirmation based only on files that exist.",
    "commands": [
      "check"
    ]
  },
  "thumbnail": {
    "provider": "builtin",
    "prompt": "A precise green check inside a repository outline on a warm neutral background"
  }
}
```

An optional `author` string overrides `Repository contributors`.

Unknown fields, Unicode dash punctuation, control characters, empty routing arrays, unsupported
types, invalid command identifiers, non-builtin fixture art, files over 64 KiB, malformed JSON,
and unsupported schema versions fail before target writes.

## Output

Preview writes one JSON object to stdout with `applied: false`, a 64-character lowercase SHA-256
`hash`, and the complete `changes` array. Apply writes one JSON object with `applied: true`, the
same hash, the applied change count, and any backup cleanup failures. Exit code 0 means success.
Invalid input, stale approval, discovery failure, or apply failure returns exit code 1.
