## Host AI — call the model from an action handler

Canvases can use the **host's** AI model — the same model + auth the Copilot app is
already running — with **no API keys, no model picker, no external `fetch`**. Action
handlers get two capabilities on their context, wired once in `extension.mjs` (the
only SDK file) and exposed by the kit:

- **`ai(question) → Promise<string>`** — a **silent** model query. No tools, and it
  is **not** added to the conversation history. This is the primitive for
  canvas-internal AI: summarize, suggest, rewrite, classify, extract. It runs
  against the **ambient conversation context**, so write self-contained,
  function-style prompts and pin the output shape — otherwise the live chat can
  bleed into the answer.

  ```js
  ai_suggest: {
    inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"], additionalProperties: false },
    handler: async ({ state, set, input, ai }) => {
      const text = (await ai(
        `You are an idea generator. Output ONLY one concise to-do (max 8 words) ` +
        `about "${input.topic}". No quotes, no numbering, no extra text.`
      )).trim().split("\n")[0];
      set({ ...state, items: [{ id: nid(), text }, ...state.items] });
      return { text };
    },
  },
  ```

- **`askAgent(prompt)`** — hand a prompt to the **main agent** in the user's
  conversation. It is **visible in chat** and **tool-capable**. Use it for
  "act in the repo / drive the agent" controls (e.g. an *Apply changes* button),
  **not** for silent text generation — that's `ai`.

Under the hood `ai` is the host's `ephemeralQuery` (a transient, no-tools,
no-history model call, e2e-tested in the Copilot SDK) and `askAgent` is a normal
session message. Both reach the host's selected model + auth.

**Why not a sub-session?** Creating an isolated `client.createSession()` from inside
an extension **hangs** — the host doesn't service a child-created session — so the
kit does not offer it. `ai` (ephemeralQuery) is the supported silent path.

**Footguns:**

- `ai()` sees the live conversation. Treat it as ambient context; for a pure
  transform, frame the prompt as a function and say "Output ONLY …".
- `ai()` throws `ai_unavailable` when the canvas runs outside the Copilot host
  (e.g. a standalone smoke test). Call it from an **action** (button- or
  agent-invoked), never from `createInitialState`/`open`.
- Don't block the panel on a slow `ai()` — `await` it in the handler, write the
  result into state, and let SSE push the update, exactly like the data-fetch shape.

Stamp this whole shape — an `ask_ai` handler (silent `ctx.ai`), a `hand_to_agent`
handler (`ctx.askAgent`), model errors captured into state, and an offline smoke
test that wires a stub host — with `node scripts/new-canvas.mjs <name> --template ai`.

## Deep links: open a session in github-app

A canvas often needs to push work OUT to the app it runs in: open a new session on
a repo, jump to Chats, pre-fill an automation. Do it with a **deep link**. The kit
builds a validated `ghapp://` URL and you render it as an ordinary anchor.

**How it reaches the app.** The canvas webview intercepts a trusted click on an
`<a target="_blank" href="ghapp://…">` and routes it into the app's deeplink
pipeline, which shows a confirmation before it clones a repo or creates a session.
A canvas only has to BUILD the URL (no OS launcher, no IPC, no SDK). The
`target="_blank"` is required: without it the webview will not route the click.

**Build links with the kit, never by hand.** The builders (re-exported from
`/kit/client.mjs` for the view, and importable from `./canvas-kit/deeplinks.mjs` in
SDK-free `canvas.mjs`) validate inputs the same way github-app does and encode every
param with `URLSearchParams`, so attacker-influenced text (a title, a fetched value)
can neither inject an extra query key nor change the target route:

```js
import { buildSessionDeepLink, quoteUntrusted } from "/kit/client.mjs";

// Open a NEW session on a repo, seeded with a prompt. Returns null when the repo
// is invalid, so you can withhold the control instead of rendering a dead link.
const href = buildSessionDeepLink({
  repo: "owner/repo",                              // required, validated owner/repo
  prompt: `Work on ${quoteUntrusted(item.title)}`, // wrap untrusted text
  mode: "interactive",                             // plan | interactive | autopilot
  // pr: 42                   -> a PR number (excludes branch / sourceBranch)
  // branch: "main"           -> base ref for a NEW worktree branch (excludes pr / sourceBranch)
  // sourceBranch: "feat/x"   -> open an EXISTING branch directly (excludes pr / branch)
  // parent: "abc-123"        -> nest under an existing session (excludes pr / sourceBranch)
});

href && html`<a class="ck-btn ck-btn-sm" href=${href} target="_blank" rel="noopener noreferrer">
  <${Icon} name="rocket" size=${14} />Open in session
</a>`;
```

**The full builder set** (each validates its input and returns a normalized
`ghapp://` URL, or null on bad input):

- `buildSessionDeepLink({ repo, prompt, pr, branch, sourceBranch, parent, mode })`: `session/new`, the primary one. The three branch selectors (`pr`/`branch`/`sourceBranch`) are mutually exclusive; `sourceBranch` opens an existing branch for collaboration, `parent` nests the new session under an existing one.
- `buildSessionDetailDeepLink(sessionId)`: open an existing session.
- `buildChatsDeepLink()`: the Chats surface.
- `buildNewChatDeepLink({ prompt })`: create a new chat and send `prompt` (required, non-empty; confirmation-gated).
- `buildNewAutomationDeepLink({ name, prompt, trigger, time, day })`: pre-fill the new-automation dialog.
- `buildIssueDeepLink({ owner, repo, number })` and `buildPullRequestDeepLink({ owner, repo, number })`.

Plus the primitives: `isRepoFullName(s)` (validate a repo before offering a link;
the reference's `set_repo` action uses it), `safeDeepLinkUrl(raw)` (validate and
normalize any app-scheme URL), `quoteUntrusted(text)` (wrap untrusted prompt text so
it reads as data), and `APP_DEEP_LINK_SCHEME` (`"ghapp"`).

**From a web surface, wrap it in the hosted launcher.** A canvas inside the app can
link `ghapp://` directly. If a link might instead be opened in a browser, wrap it so
dotcom handles retry, fallback, and an app-missing install prompt:

```js
import { hostedLauncherUrl } from "/kit/client.mjs";
const url = hostedLauncherUrl(href, { entryPoint: "my_canvas" });
// -> https://github.com/copilot/app/launch?entry_point=my_canvas&open=<encoded ghapp://…>
```

**Rules:**

- **Never put secrets or sensitive content in a deep-link `prompt`.** The URL is
  handed to the OS.
- **Always wrap untrusted free text with `quoteUntrusted`** before putting it in a
  prompt, and let the builders encode the rest.
- **A builder returns null on invalid input.** Guard on it and hide the control
  instead of rendering a broken link.
- **The anchor must be `target="_blank"`,** or the canvas webview will not route it
  into the app.

**Full schema.** `reference/deeplinks.md` documents every route, its parameters, and
the validation the builders apply (and how to add a route if the app grows one).

The reference canvas (`reference/decision-log/`) demonstrates every builder: a
`set_repo` action, a per-decision "Open in session" link (`session/new`), and an
"Open in github-app" card with Chats, a pre-filled new automation, issue/PR links,
open-by-session-id, and a "web links" toggle that wraps each link with
`hostedLauncherUrl`.

## Domain strategy — shared board vs personal profile

State is keyed by the domain id `resolveDomainId` returns. Two intents, identical
machinery (`fileFor` sanitizes the id to a filename — copy it verbatim):

- **Shared board** (most canvases): key off a topic the agent and user both name.
  `resolveDomainId: (input) => (input?.domain ? String(input.domain) : "default")`.
  Anyone who opens `domain: "tech"` sees the same board.
- **Personal store**: key off an identity, not a topic.
  `resolveDomainId: (input) => (input?.profile ? String(input.profile) : "default")`,
  with the input schema property named `profile`. Use this for per-learner /
  per-user data that shouldn't bleed across topics.

Pick the noun (`domain` vs `profile`) deliberately — it's the whole contract for
who shares what.

## Sharing canvas state across users (GitHub-backed)

When the user says **"share this canvas state with other users on GitHub"** (or
wants several people to edit the same board), don't invent a sync mechanism and
don't round-trip a gist by hand — gists are single-writer. Back the canvas with a
file in a **private GitHub repo** using the kit's `githubStore`
(`kit/github-store.mjs`): GitHub is both the shared store and the access control
(only repo collaborators can read/write), and there's no server to run.

**Ask the user which repo** to store the data in — a private repo whose
collaborators are the people who should edit the board. It can be different from
wherever they installed the canvas. Then wire the runtime to it:

```js
import { githubStore } from "./canvas-kit/github-store.mjs";
import { userStore } from "./canvas-kit/storage.mjs";

// The user picks the target repo; read it from env so it isn't hardcoded.
const OWNER  = process.env.CANVAS_STATE_OWNER  || "your-org";
const REPO   = process.env.CANVAS_STATE_REPO   || "your-canvas-state-repo";
const BRANCH = process.env.CANVAS_STATE_BRANCH || "main";

const local  = (d) => userStore(EXT_NAME, `${safe(d)}.json`);      // offline mirror/fallback
const remote = (d) => githubStore({ owner: OWNER, repo: REPO, path: `state/${safe(d)}.json`, branch: BRANCH });

createCanvasRuntime({
  // …
  // Read the shared repo; mirror locally and fall back to it if the repo is
  // unreachable or the caller lacks access, so the panel never hard-fails.
  loadState: async (d) => {
    try { const r = await remote(d).load(null); if (r != null) { await local(d).save(r).catch(()=>{}); return r; } }
    catch (e) { console.error("remote load failed, using local:", e.message); }
    return local(d).load(null);
  },
  // Write the shared repo AND keep a local mirror; a transient repo error is
  // logged, not thrown, so an edit still lands locally and reconciles next poll.
  saveState: async (d, state) => {
    await local(d).save(state).catch(()=>{});
    try { await remote(d).save(state); } catch (e) { console.error("remote save failed (kept local):", e.message); }
  },
  // Live pull: poll the repo (cheap ETag 304 when unchanged) so a collaborator's
  // commit shows up here within a few seconds. Only polled while a panel is open.
  syncState: async (d) => { try { return await remote(d).poll(); } catch { return { changed: false }; } },
  syncIntervalMs: 5000,
});
```

Key facts to tell the user and honor in code:

- **Access = repo collaborators.** They add each teammate with **push** access
  (`gh api -X PUT repos/<o>/<r>/collaborators/<user> -f permission=push`); private
  invites must be accepted before they can write.
- **Token** comes from `GH_TOKEN` / `GITHUB_TOKEN`, else `gh auth token` (needs the
  `repo` scope), and is only ever sent as an `Authorization` header — never logged
  or written to the repo. Pass `token` explicitly to override.
- **Conflicts:** every write is optimistic-locked by the blob SHA; a colliding
  commit re-reads + retries. Default is last-writer-wins for the whole document —
  pass `merge(remoteState, myState)` to `githubStore` to resolve field-by-field
  (e.g. union a board's items by id) so two people editing different items never
  clobber each other.
- **Untrusted remote:** if you set `config.stateSchema`, it guards **sync-adopted**
  state too — a collaborator's malformed edit (or a hand-edit on github.com) that
  violates the schema is rejected instead of being broadcast to viewers. Define a
  `stateSchema` for any shared board so a bad remote can't corrupt everyone's panel.
- **Distribution:** put the extension folder in that same repo (`extension/`) so a
  collaborator installs the canvas AND gets the live data from one place.

## Patterns & limitations (know these)

- **Bundled catalog.** For curated seed data (courses, presets), ship a separate
  `catalog.mjs`: plain data plus a `buildCourse(...)`-style builder that assigns
  **deterministic positional ids** (`es-u1-l2`) so the same catalog always
  produces the same ids. Keep the bulk data terse with tiny constructor helpers.
- **`statusLine` is computed once, at open.** The panel's status string is set on
  `openInstance` and is **not** re-pushed when an action mutates state, so a
  count in `statusLine` goes stale. Show live counts **inside** the canvas body
  (which re-renders on every SSE push), and treat `statusLine` as an
  open-time-only summary.
- **Rich-payload actions.** Action `inputSchema`s default to
  `additionalProperties: false` on purpose: the schema is the contract the agent
  fills, and a strict schema keeps the model from smuggling in unvalidated/typo'd
  fields — only the properties you declare reach your handler. When the UI
  genuinely needs to hand the handler a whole object (e.g. the article being
  saved) rather than scalar fields, set `additionalProperties: true` on *that*
  action's `inputSchema` and denormalize what you need into durable state in the
  handler. Flip it deliberately, per-action — not as a blanket default.
- **Install layout / SDK resolution.** A shipped extension folder contains only
  `copilot-extension.json` (`{ "name", "version": 1 }` — no `package.json`),
  `extension.mjs`, `canvas.mjs`, `web/`, and the nested `canvas-kit/`. The kit is
  plain ESM that Node runs directly — **no bundler, no transpile, no build step,
  no `package.json`** in the extension (the stamped `test/smoke.test.mjs` runs
  with bare `node`). The host resolves `@github/copilot-sdk/extension` for you;
  `extension.mjs` is the only file that imports it. Don't add a `package.json` or
  a build step to a shipped canvas.
