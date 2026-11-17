# dsh-search

English | [中文](README.zh.md)

Multi-backend web search for DeepSeek Harness: 23 search providers you turn on one by one, each with an explicit access mode and a visible cost tier.

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

The **Test & diagnostics** tab runs one explicit search against a saved backend and shows the exact request outcome.

## Backends and cost

The list is grouped by the cheapest path a backend offers, so anything with a free option always leads. Each row carries a chip per access mode with that mode's own tier, and the selected one is highlighted.

| Group | Backends | Notes |
| --- | --- | --- |
| **Free path available** | Keenable, AnySearch, Exa, Parallel, You.com, DuckDuckGo, Reddit | No signup, no key, works immediately |
| **Own account** | X | Your own X browser cookies: no fee, but it breaks when X changes its request signing |
| **Self-hosted** | SearXNG, open-websearch | You run the service and set your own limits |
| **Free allowance** | Linkup, Tavily, Brave, Zhihu (web and site), Baidu, Doubao | Sign up for a key, free within the quota |
| **Trial credits** | Serpex | One-off trial credits, then paid |
| **Paid** | Mojeek, Anthropic, OpenAI, DeepSeek, Tencent WSA | Billed per use; check the price before enabling |

- Every backend is **disabled by default**; nothing is enabled automatically.
- Per-backend quotas, prices, sources and the date they were checked: [docs/BACKENDS.md](docs/BACKENDS.md).

## Tools

- `web_search` — the backend fan-out described above.
- `web_search_plus` — search with a strategy for this call only: `mode` (single or parallel), `backends` (a subset of the enabled ones), `allBackends` + `exclude` (everything except a few, cheaper to write than listing ids), `compact` (links and titles only, no snippets, which is the biggest lever on result size) and `maxResults`. Saved configuration is untouched, a backend that is not enabled is reported rather than silently dropped, and the result names the backends that actually ran.
- `reddit_thread` — read one Reddit post with its comment tree, so a model can quote the discussion instead of guessing. Capped by depth, comment count and character budget.
- `search_manage` — inspect or change this plugin's settings from the agent side.

## Development

```sh
npm install --ignore-scripts --legacy-peer-deps
npm run check
```

Design notes: [docs/PLAN.md](docs/PLAN.md). Verification status: [docs/VERIFICATION.md](docs/VERIFICATION.md).

## License

MIT.

## Friends

- [LINUX DO](https://linux.do) — the community where this plugin's backend survey started.
