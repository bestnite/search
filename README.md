# dsh-search

English | [中文](README.zh.md)

Multi-backend web search for DeepSeek Harness: 21 search providers you turn on one by one, each with an explicit access mode and a visible cost tier.

## Install

```sh
dsh plugin add @nite07/dsh-search
dsh --profile web   # or restart your running dsh web process
```

Or install it from **Settings → Plugins → Add plugin**.

Then make it the search source: open **Settings → Web search**. If the page says the current provider is something else, click **Use this plugin for web search**.

## Quick start

1. Open **Settings → Web search**.
2. In the **Backends** tab, pick the providers you want, choose **anonymous** or **API key** for each, and check the cost line before enabling.
3. Press **Save settings**. Every backend starts disabled, so nothing is called until you save.

The **Test & diagnostics** tab runs one explicit search against a saved backend and shows the exact request outcome.

## Backends and cost

Each backend is filed under a cost tier for the selected access mode: free, free allowance (key required), trial credits, paid usage, or self-hosted.

- Free anonymous tiers that work without any account: Keenable, Exa, You.com, AnySearch, Parallel, Reddit.
- Local SearXNG is supported and needs no key.
- A **Live-tested** badge means this plugin completed a real call to that backend.

Per-backend quotas, prices, sources and the date they were checked: [docs/BACKENDS.md](docs/BACKENDS.md).

## Tools

- `web_search` — the backend fan-out described above.
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
