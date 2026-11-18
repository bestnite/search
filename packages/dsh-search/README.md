# dsh-search

English | [中文](README.zh.md)

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
2. In the **Backends** tab, enable one that needs no account — Keenable, AnySearch, Exa, Parallel,
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
3. In **Settings → Web search → Backends**, fill the **Shared browser** block: endpoint
   (`ws://<host>:3000/ws`), session file (optional), read timeout, and the per-site concurrent reads
   cap. Paste the printed token as the **endpoint token**.
4. Enable the Xiaohongshu backend in browser mode and save.

The token guards the browser endpoint, not a site account, so it is stored once for the browser rather
than per backend. The shared endpoint wins over a backend's own; the backend endpoint is only a
fallback while the shared one is empty. The session file must be the one the container writes,
otherwise every read starts signed out. Nothing in this plugin can sign in — login stays with whoever
owns that browser.

The per-site concurrent-reads setting bounds how many reads run on one site at once. It is not the
global parallel-backend count on the behaviour tab: that one limits how many providers a single search
queries. A 429 answer lowers the per-site cap to 1 for the rest of that browser session.

## Tools

- `web_search` — the backend fan-out described above.
- `web_search_plus` — search with a strategy for this call only: `mode` (single or parallel),
  `backends` (a subset of the enabled ones), `allBackends` + `exclude` (everything except a few),
  `compact` (links and titles only, the biggest lever on result size) and `maxResults`. Saved
  configuration is untouched, a backend that is not enabled is reported rather than silently dropped,
  and the result names the backends that actually ran. Can be switched off in settings.
- `x_thread` — read one X post with its replies. Needs the X backend in session mode; depth, reply
  count and character budget are capped.
- `xiaohongshu_note` — read one note: text, author, engagement counts, tags, pictures, and optionally
  its top-level comments. Takes the share link (which carries the token the read needs) or a note id
  from an earlier search. Needs the Xiaohongshu backend in browser mode plus a shared browser endpoint.
- `reddit_thread` — read one Reddit post with its comment tree. Capped by depth, comment count and
  character budget.
- `search_manage` — inspect or change this plugin's settings from the agent side, including the shared
  browser token (`scope: browser`) instead of a backend credential.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Search returns nothing | Every backend is disabled until you save. Open the Backends tab, enable one, save. |
| "Not signed in" from Xiaohongshu | The browser container lost its session. Open the noVNC page and sign in again; the next read reloads the state file. |
| Xiaohongshu fails with no endpoint | Fill **Shared browser → endpoint**, or set the backend's own endpoint. |
| Rate limit from one backend | That backend refused the request. Wait, or lower its per-minute budget on its row. |
| "Configuration revision conflict" | Another window saved first. Reload the page and apply your change again. |

## Development

See [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md) for the workspace commands. Design notes:
[docs/PLAN.md](docs/PLAN.md). Verification status: [docs/VERIFICATION.md](docs/VERIFICATION.md).

## License

MIT.
