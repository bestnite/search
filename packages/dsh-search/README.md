# dsh-search

English | [中文](README.zh.md)

Multi-backend web search for DeepSeek Harness: 24 search providers you turn on one by one, each with an explicit access mode and a visible cost tier.

## Install

```sh
dsh plugin add @nite07/dsh-search
dsh --profile web   # or restart your running dsh web process
```

Or install it from **Settings → Plugins → Add plugin**.

Then make it the search source: open **Settings → Web search**. If the page says the current provider is something else, click **Use this plugin for web search**.

## Quick start

1. Open **Settings → Web search**.
2. In the **Backends** tab, pick the providers you want, choose the access mode for each, and check the cost line before enabling.
3. Press **Save settings**. Every backend starts disabled, so nothing is called until you save.

The **Test & diagnostics** tab runs one explicit search against a saved backend and shows the exact request outcome. A browser-backed backend (currently Xiaohongshu) also needs the shared browser set up first — see below.

## Backends and cost

The list is grouped by the cheapest path a backend offers, so anything with a free option always leads. Each row carries a chip per access mode with that mode's own tier, and the selected one is highlighted.

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

## Browser-backed backends

Xiaohongshu answers only its own page runtime, so it has no callable HTTP endpoint. That backend drives a browser you host instead of a vendor API: nothing is billed per call and no public quota applies, and the cost is the machine that runs the browser.

One browser serves every backend in browser mode:

1. Start the browser container from the `image/` directory of [`@nite07/search-core`](https://git.nite07.com/nite/search/src/branch/main/packages/core/image). It prints the endpoint and a bearer token at startup.
2. Open its noVNC page (`http://<host>:6080/vnc.html`) and sign in to Xiaohongshu in the window that is already open. That window is the session; the container writes it to disk every minute.
3. In **Settings → Web search → Backends**, fill the **Shared browser** block — endpoint (`ws://<host>:3000/ws`), session file (optional), read timeout — and paste the printed token as the **endpoint token**.

The token guards the browser endpoint, not a site account, so it is stored once for the browser rather than per backend. The shared endpoint wins over a backend's own; a backend's endpoint is a fallback used only while the shared one is empty. The session file must be the one the container writes — otherwise every read starts signed out. Nothing in this plugin can sign in: login stays with whoever owns that browser.

## Tools

- `web_search` — the backend fan-out described above.
- `web_search_plus` — search with a strategy for this call only: (can be switched off in settings, which stops registering it) `mode` (single or parallel), `backends` (a subset of the enabled ones), `allBackends` + `exclude` (everything except a few, cheaper to write than listing ids), `compact` (links and titles only, no snippets, which is the biggest lever on result size; can be made the default in settings) and `maxResults`. Saved configuration is untouched, a backend that is not enabled is reported rather than silently dropped, and the result names the backends that actually ran.
- `x_thread` — read one X post with its replies, so a discussion a search surfaced can be quoted. Needs the X backend in session mode; a bounded depth, reply count and character budget apply.
- `xiaohongshu_note` — read one Xiaohongshu note: text, author, engagement counts, tags, its pictures, and optionally its top-level comments. Takes the share link (which carries the token the read needs) or a note id from an earlier search in the same session. Needs the Xiaohongshu backend in browser mode plus a shared browser endpoint, and reports a disabled backend, a missing endpoint or a missing note token instead of an empty note.
- `reddit_thread` — read one Reddit post with its comment tree, so a model can quote the discussion instead of guessing. Capped by depth, comment count and character budget.
- `search_manage` — inspect or change this plugin's settings from the agent side, including the shared browser token (`scope: browser`) instead of a backend credential.

## Development

Run from the monorepo root (the root lockfile owns all workspace dependencies):

```sh
npm ci --ignore-scripts
npm run check
```

See the [workspace guide](../../README.md) for build order, SDK development dependencies and packaging.

Design notes: [docs/PLAN.md](docs/PLAN.md). Verification status: [docs/VERIFICATION.md](docs/VERIFICATION.md).

## License

MIT.

## Friends

- [LINUX DO](https://linux.do) — the community where this plugin's backend survey started.
