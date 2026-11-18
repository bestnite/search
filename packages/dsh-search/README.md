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

Backends in `key` or `session` mode need a credential. Enter it on the provider's card and save.
Credentials are kept in the DSH credential store, not in the configuration file.

Search and page fetching share a provider's saved key. You can enter it on either the **Search** or
**Page fetch** tab; the search and fetch access modes and limits are configured separately.

## Settings layout

Switching tabs keeps your draft. Click **Save settings** to apply changes.

| Tab | What you can configure |
| --- | --- |
| **Search behavior** | Query shape, safe search, language and region, agent tool switches |
| **Reliability** | Retries, circuit breaker, cache and diagnostics retention |
| **Test & diagnostics** | Test a backend against saved settings, view recent outcomes, import/export |
| **Search** | Search backends, access modes, costs, endpoints and credentials |
| **Browser** | Shared browser endpoint, endpoint token, session file, read limits and browser-dependent features |
| **Page fetch** | Fetch methods, fallback rules, provider, timeouts, output limits and browser options |

## Saving and checking the browser

Click **Save settings** and check the result. If a setting is invalid, follow the issue's link to
correct it; your draft is kept. If another window saved first, reload the latest settings and reapply
your changes. If the result is unconfirmed, check the saved settings before trying again.

When Xiaohongshu search or browser-based page fetching is enabled, saving checks the browser endpoint
and token. You can also use **Check connection** on the **Browser** tab before saving. A successful
check confirms the connection, **not** that you are signed in to a website.

Search uses the shared browser endpoint when set, otherwise the backend's own endpoint. Browser-based
page fetching requires the shared endpoint. If the browser is unavailable, disable all
browser-dependent features to save settings offline, then fix the connection before re-enabling them.

## Backends and cost

The list is grouped by the cheapest path each backend offers, so anything with a free option leads.
Each row carries a chip per access mode with that mode's own tier, and the selected one is
highlighted.

| Group | Backends | Notes |
| --- | --- | --- |
| **Free path available** | Keenable, AnySearch, Exa, Parallel, You.com, DuckDuckGo, Reddit | No signup, no key, works immediately |
| **Own account** | X | Your own X browser cookies; a valid session is required |
| **Self-hosted** | SearXNG, open-websearch, Xiaohongshu | You run the service and set your own limits; Xiaohongshu reads through a browser container you host |
| **Free allowance** | Linkup, Tavily, Brave, Zhihu (web and site), Baidu, Doubao | Sign up for a key, free within the quota |
| **Trial credits** | Serpex | One-off trial credits, then paid |
| **Paid** | Mojeek, Anthropic, OpenAI, DeepSeek, Tencent WSA | Billed per use; check the price before enabling |

- Every backend is **disabled by default**; nothing is enabled automatically.
- Per-backend quotas, prices, sources and the date they were checked: [docs/BACKENDS.md](docs/BACKENDS.md).

## Xiaohongshu

Search Xiaohongshu and read notes through a browser you host and sign in to yourself. There is no
per-call charge from this plugin; you cover the cost of running the browser.

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

The endpoint token protects access to the browser; it does not sign you in to Xiaohongshu. If you set
a session file, use the one written by the container. Sign in through noVNC; the plugin cannot sign in
for you.

The per-site concurrent-reads setting limits browser reads on one site. The parallel-backend setting
on **Search behavior** instead limits how many providers a search queries.

## Tools

- `web_search` — the backend fan-out described above: every enabled backend.
- `web_search_plus` — search with a strategy for this call only: `backends` (a subset of the enabled
  ones; one id runs that backend alone, several run in parallel), `allBackends` + `exclude` (everything
  except a few), `compact` (shorter results with backend provenance) and `maxResults`.
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
- `web_extract` — fetch one page as Markdown or HTML. **Off by default**; enable **Allow web_extract**
  on the **Page fetch** tab to make it available to the agent. Requires `url` and `format`
  (`markdown` or `html`) and uses your saved fetch settings. Treat returned page content as untrusted.

## Page fetching

Fetch a single URL as **Markdown** for reading or **HTML** for inspecting page structure. Available
methods are direct HTTP, your shared browser, and a fetch provider. Configure which methods to use,
their order and fallback rules on **Settings → Web search → Page fetch**.

1. Enable at least one fetch method. For browser fetching, set up the shared endpoint and token on the
   **Browser** tab. For a provider, select it and choose its fetch access mode; add a key if required.
2. Review costs, timeouts, output limits and network access settings, then **Save settings**.
3. Enter a URL and choose **Markdown** or **HTML** in the page-fetch test, then run it against the saved
   settings. Enable **Allow web_extract** if you also want the agent to fetch pages.

Choose a provider in the settings page and check its supported formats and costs. Some modes work
without an API key; others require a saved key. Search and fetching share a provider's key.
For pages that need JavaScript, use the shared browser. Access to protected pages is not guaranteed.

**Tests make real network requests and may incur provider charges.**

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Search returns nothing | Every backend is disabled until you save. Open the Search tab, enable one, save. |
| "Not signed in" from Xiaohongshu | The browser container lost its session. Open the noVNC page and sign in again; the next read reloads the state file. |
| Xiaohongshu fails with no endpoint | Fill the shared endpoint on the **Browser** tab, or set the backend's own endpoint on its search card. |
| Rate limit from one backend | That backend refused the request. Wait, or lower its per-minute budget on its row. |
| "Configuration revision conflict" | Another window saved first. Reload the page and apply your change again; the draft is kept. |
| Save refused: browser endpoint unreachable or token rejected | The save gate could not verify an enabled browser dependency. Open the Browser tab, run **Check connection**, fix the endpoint or token, or disable every browser-dependent feature to save offline. |
| A setting is invalid | Follow the issue's fix link to the setting, correct it and save again. |

## Development

See [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md) for the workspace commands. Design notes:
[docs/PLAN.md](docs/PLAN.md). Verification status: [docs/VERIFICATION.md](docs/VERIFICATION.md).

## License

MIT.
