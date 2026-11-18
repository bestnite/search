# dsh-search

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/@nite07/dsh-search?label=npm&style=flat-square&color=cb3837)](https://www.npmjs.com/package/@nite07/dsh-search)
[![downloads](https://img.shields.io/npm/dm/@nite07/dsh-search?label=downloads&style=flat-square&color=cb3837)](https://www.npmjs.com/package/@nite07/dsh-search)

Multi-backend web search for DeepSeek Harness: 24 providers, switched on one at a time, each with an
explicit access mode and a visible cost tier.

## Install

```sh
dsh plugin add @nite07/dsh-search
dsh --profile web   # or restart your running dsh web process
```

You can also install it from **Settings → Plugins → Add plugin**.

Then make it the search source: open **Settings → Web search**. If the page says another provider is
active, click **Use this plugin for web search**.

## First search

1. Open **Settings → Web search**.
2. In the **Search** tab, enable one that needs no account — Keenable, AnySearch, Exa, Parallel,
   You.com, DuckDuckGo or Reddit.
3. Check the cost line on that row, then press **Save settings**.
4. Ask the agent to search something. Every backend starts disabled, so nothing is called until you
   save.

To check a provider without going through the agent, use **Test & diagnostics**: it sends one real
request and shows the outcome verbatim, including the failure reason.

## Adding a key

Backends in `key` or `session` mode need a credential. Paste it into the credential field on that
backend's row and save; the plugin stores it in the DSH credential store under a name fixed in code,
so a saved config can never redirect a lookup to a different secret. Nothing is stored in the
configuration file itself.

## Settings layout

The page edits one draft. Switching tabs never saves, never discards an edit, and never moves a value
between operations.

| Tab | What it owns |
| --- | --- |
| **Search behavior** | Query shape, safe search, language and region, agent tool switches |
| **Reliability** | Retries, circuit breaker, cache and diagnostics retention |
| **Test & diagnostics** | One explicit backend test against saved settings, recent outcomes, import/export |
| **Search** | The backend catalog: access mode, cost chips, search endpoint and credential |
| **Browser** | The shared Playwright endpoint, endpoint token, session file, per-site read cap, and every enabled search or fetch feature that depends on it |
| **Page fetch** | Routes, fallback rules, the fetch provider (a fixed radio choice including **none**), fetch-operation settings, and the fetch-only browser context/settle/selector options |

Search and page fetch render the same provider card. A backend's credential is one stored secret bound
to one record, so the same control appears in both views without asking for the value a second time.
Search caps never bound a page fetch: the fetch operation keeps its own access mode, endpoint, timeout
and options, and the card says so.

## Saving and the browser gate

**Save settings** validates first, then writes. The outcomes are distinct:

- **Rejected validation**: nothing is written. The draft keeps every edit, and the page lists the
  localized cause with a link that switches to the owning tab, unfolds the provider card or fallback
  rule, and focuses the actual control. Route problems name the route kind (HTTP, browser, provider),
  not an array index, so they stay readable after reordering.
- **Revision conflict**: another editor saved first. The revision is checked again inside the
  editor's file lock against the effective current entry config, migrated and filled with schema
  defaults. The inherited layer is not merged again, because a profile patch value replaces the whole
  value; merging it back would resurrect a value the current patch already replaced. A save that
  landed during verification therefore cannot be overwritten. The page reloads the latest revision and
  keeps your draft; it is not reported as an invalid value.
- **Cancelled**: the request or the plugin lifetime was cancelled during verification. The save stops
  before the write and the draft is unchanged.
- **Definite write failure**: the server reported a write failure; the page reads the saved state back
  before saying anything. If that read-back succeeds and differs, the server reason is shown beside
  the preserved draft; if it fails, the page reports an unknown result instead of claiming nothing
  was written.
- **Unconfirmed response**: only a transport failure that left the saved state different is reported
  this way, after reading it back. A request this page sends is never replayed automatically.

When an enabled search backend reads through a browser (Xiaohongshu) or the fetch browser route is on,
the server proves the effective endpoint before writing. It reads the stored token, attaches once per
distinct endpoint/token pair, creates and closes one isolated context, and disconnects. The whole
check — token read, connection, context and cleanup — is bounded to about five seconds. It never
navigates, never sends a site or business request, and never closes the remote browser other clients
use. A successful connection only proves the endpoint and token work; it is **not** a site login.

The search path uses the shared endpoint first and the backend's own endpoint only while the shared
one is empty. The page-fetch browser route uses the shared endpoint only. Grouped checks follow those
same rules, so a search fallback cannot make the fetch route look verified.

With every browser-dependent feature disabled, browser settings save offline without a probe. Turn the
dependents off first, save, fix the endpoint or token, then save the enabled configuration again.

The **Browser** tab can run the same bounded check manually against the endpoint in the draft, before
saving. The check accepts no credential argument: it always uses the stored token, and an agent-facing
check may only re-test the saved endpoint. Changing the endpoint or token marks the displayed result
stale, and every save rechecks the effective endpoint on the server.

## Backends and cost

The list is grouped by the cheapest path each backend offers, so anything with a free option leads.
Each row carries a chip per access mode with that mode's own tier, and the selected one is
highlighted.

| Group | Backends | Notes |
| --- | --- | --- |
| **Free path available** | Keenable, AnySearch, Exa, Parallel, You.com, DuckDuckGo, Reddit | No signup, no key, works immediately |
| **Own account** | X | Your own X browser cookies: no fee, but it breaks when X changes the operations its page embeds |
| **Self-hosted** | SearXNG, open-websearch, Xiaohongshu | You run the service and set your own limits; Xiaohongshu reads through a browser container you host |
| **Free allowance** | Linkup, Tavily, Brave, Zhihu (web and site), Baidu, Doubao | Sign up for a key, free within the quota |
| **Trial credits** | Serpex | One-off trial credits, then paid |
| **Paid** | Mojeek, Anthropic, OpenAI, DeepSeek, Tencent WSA | Billed per use; check the price before enabling |

- Every backend is **disabled by default**; nothing is enabled automatically.
- Per-backend quotas, prices, sources and the date they were checked: [docs/BACKENDS.md](docs/BACKENDS.md).

## Xiaohongshu

Xiaohongshu answers only its own page runtime, so it has no callable HTTP endpoint. It reads through a
browser you host: nothing is billed per call, and the cost is the machine running the browser.

1. Start the browser container from [packages/core/image](../core/image/README.md). Its log prints an
   endpoint and a bearer token.
2. Open `http://<host>:6080/vnc.html` and sign in to Xiaohongshu in the window that is already open.
   The container writes that session to disk every minute.
3. Open **Settings → Web search → Browser**. Fill the shared endpoint (`ws://<host>:3000/ws`), the
   optional session file, the read timeout and the per-site concurrent reads cap. Paste the printed
   token into **Endpoint token**. The Browser tab lists every enabled feature that depends on it.
4. Enable the Xiaohongshu backend in browser mode on the **Search** tab and save. The save checks the
   endpoint and token before writing; if it refuses, use **Check connection** on the Browser tab to see
   the specific cause.

The token guards the browser endpoint, not a site account, so it is stored once for the browser rather
than per backend. The shared endpoint wins over a backend's own; the backend endpoint is only a
fallback while the shared one is empty. The session file must be the one the container writes,
otherwise every read starts signed out. Nothing in this plugin can sign in — login stays with whoever
owns that browser.

The per-site concurrent-reads setting bounds how many reads run on one site at once. It is not the
global parallel-backend count on the behaviour tab: that one limits how many providers a single search
queries. A 429 answer lowers the per-site cap to 1 for the rest of that browser session.

## Tools

- `web_search` — the backend fan-out described above: every enabled backend.
- `web_search_plus` — search with a strategy for this call only: `backends` (a subset of the enabled
  ones; one id runs that backend alone, several run in parallel), `allBackends` + `exclude` (everything
  except a few), `compact` (links and titles only, the biggest lever on result size) and `maxResults`.
  Saved configuration is untouched, a backend that is not enabled is reported rather than silently
  dropped, and the result names the backends that actually ran. Can be switched off in settings.
- `x_thread` — read one X post with its replies. Needs the X backend in session mode; depth, reply
  count and character budget are capped.
- `xiaohongshu_note` — read one note: text, author, engagement counts, tags, pictures, and optionally
  its top-level comments. Takes the share link (which carries the token the read needs) or a note id
  from an earlier search. Needs the Xiaohongshu backend in browser mode plus a shared browser endpoint.
- `reddit_thread` — read one Reddit post with its comment tree. Capped by depth, comment count and
  character budget.
- `backend_status` — one compact read of what is on: which backends are enabled, each one's mode,
  cost tier, whether a credential is stored (never the value), today's call count and the last
  outcome with its error, plus whether this plugin is the active provider. Pass a backend id for
  its full mode list, limits and option fields. Read-only; nothing is enabled or spent.
- `search_manage` — inspect or change this plugin's settings from the agent side, including the shared
  browser token (`scope: browser`) instead of a backend credential. Also runs the user-triggered page
  fetch test (`action: "fetch-test"` with `url` and `format`).
- `web_extract` — fetch **one** page: `url` plus a required `format` (`markdown` to read, `html` to
  inspect structure). Route order, provider selection, credentials and fallback rules are saved
  configuration, never call parameters. Returned page content is untrusted. **Off by default**: the
  Fetch tab's "Allow web_extract" switch registers or hides the tool entirely, so an agent with a
  stronger native fetch tool does not receive a duplicate.

## Page fetching

The same settings page has a **Page fetch** tab beside **Search**, editing the same draft:

- **Routes** — HTTP, the shared browser and one provider, each with its own switch, timeout, order
  (↑/↓ buttons, keyboard reachable) and fallback rules. Rules are OR, conditions inside one rule are
  AND, and a condition is true/false/unavailable; a missing field is never an empty string. Presets
  add an ordinary editable status rule or a heuristic challenge-page rule.
- **Provider** — the verified fetch-capable providers only (Exa and Parallel in this release), with
  the formats each one can return, its own fetch access mode, endpoint, timeout and options. Both
  return native Markdown; asking for HTML skips that route without a request and the next enabled
  route serves the page instead.
- **Safety and limits** — overall deadline, redirect cap, acquisition and output limits, rule scan
  width, public-only/private-network policy, and the delegated-fetching opt-in a browser or provider
  route needs because the remote side resolves the target itself.
- **Test** — a URL, a required format and one user-triggered run against the *saved* configuration.
  It can reach the network (and a provider may meter it); nothing runs on render or save.

Readiness problems are shown before a test: no enabled route, a browser route without an endpoint, a
provider route without a provider, a missing provider credential, or a delegated route with the opt-in
off.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Search returns nothing | Every backend is disabled until you save. Open the Search tab, enable one, save. |
| "Not signed in" from Xiaohongshu | The browser container lost its session. Open the noVNC page and sign in again; the next read reloads the state file. |
| Xiaohongshu fails with no endpoint | Fill the shared endpoint on the **Browser** tab, or set the backend's own endpoint on its search card. |
| Rate limit from one backend | That backend refused the request. Wait, or lower its per-minute budget on its row. |
| "Configuration revision conflict" | Another window saved first. Reload the page and apply your change again; the draft is kept. |
| Save refused: browser endpoint unreachable or token rejected | The save gate could not verify an enabled browser dependency. Open the Browser tab, run **Check connection**, fix the endpoint or token, or disable every browser-dependent feature to save offline. |
| A validation issue names a route kind I cannot find | Click the issue's fix link: it opens the owning tab, unfolds the route's fallback rules and focuses the control. |

## Development

See [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md) for the workspace commands. Design notes:
[docs/PLAN.md](docs/PLAN.md). Verification status: [docs/VERIFICATION.md](docs/VERIFICATION.md).

## License

MIT.
