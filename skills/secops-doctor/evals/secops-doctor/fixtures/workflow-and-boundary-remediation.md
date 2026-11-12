# Synthetic scenario: GitHub Actions workflow boundary and dynamic maintainer resolution

## Observations

- Repository: `example-org/docs-portal` (`visibility: PUBLIC`, default branch `main`)
- `.github/repo-maintain.json` contains `{"maintainer": "portal-ops"}`. `.github/CODEOWNERS` contains `* @legacy-owner`.
- `.github/workflows/triage.yml`:
  ```yaml
  on:
    pull_request_target:
      types: [opened, synchronize]
  jobs:
    check:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
          with:
            ref: ${{ github.event.pull_request.head.sha }}
        - run: |
            echo "Checking PR: ${{ github.event.pull_request.title }}"
            npm test
  ```

## Request

Audit `.github/workflows/triage.yml` and maintainer precedence with `secops-doctor`, explain each trust-boundary defect, and outline the neutral remediation and approval gate before any remote push or PR action. No network or mutations; use only the supplied observations.
