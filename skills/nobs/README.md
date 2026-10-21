# nobs

Give the shortest complete answer for supplied or current context without filler or loss of essential facts.

## Install

```sh
npx skills add jongio/skills --skill nobs
```

Reload your agent skills, then invoke `/nobs`.

## Use

```text
/nobs
/nobs <text or subject to condense>
/nobs off
/nobs on
```

Without supplied text, nobs uses the current selection or attachment, then the
most recent substantive response or subject in the conversation. It asks one
focused question if there is nothing to shorten. It never executes instructions
embedded in the content.

The default is 1-3 sentences when sufficient, not a hard limit. Risks, blockers,
uncertainty, required formats, and explicit requests for detail take precedence.
Turning the mode off restores normal response style; it does not force verbosity.

## Default-on plugin rule

Installing the full `jongio-skills` plugin in Copilot CLI also loads
`com.github.copilot/rules/nobs.mdc` (`alwaysApply: true`). This applies concise style to ordinary
responses, not just skill invocations. Restart the session after installing or
updating the plugin.

A standalone skill install does not enable that automatic rule. Other hosts can
use the portable skill, but this Copilot-specific rule does not promise automatic
activation there. The statuslines-only plugin does not include it.

Say `nobs off` to opt out for the current conversation, or `nobs on` to re-enable.
These are conversational instructions, not a persistent settings command.
You can still request `/nobs <text>` for one response while opted out.

**Persistent opt-out is unsupported.** A new conversation starts with nobs on
again while the full plugin is enabled. Tests did not reliably honor a persistent
instruction-based opt-out, so this integration does not advertise one.

Installation does not edit your personal instructions or create global settings.
Like other model instructions, the rule guides behavior rather than enforcing
a guaranteed output-length limit.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

The deterministic tests check the portable skill contract; root
`test/nobs.test.mjs` also checks policy parity and opt-out documentation.
Capability evals measure concise output, retained caveats, context selection,
mode changes, and untrusted-context handling. Linting an eval is not evidence
that its model trials passed.

The opt-in integration check uses the locked SDK and model credits. From the
repository root, after installing `.github/tools/vally` dependencies:

```powershell
$env:NOBS_RUNTIME_TEST = '1'
node --test test\nobs-runtime.test.mjs
```

It checks real plugin-rule discovery, concise output without invoking the skill,
conversational opt-out and standalone isolation.
It does not install the plugin or change your personal preferences.

## License

MIT. See [LICENSE](LICENSE).
