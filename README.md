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

- Free anonymous tiers that work without any account: Keenable, Exa, You.com, AnySearch, Parallel.
- Local SearXNG is supported and needs no key.
- A **Live-tested** badge means this plugin completed a real call to that backend.

Per-backend quotas, prices, sources and the date they were checked: [docs/BACKENDS.md](docs/BACKENDS.md).

## Behaviour worth knowing

- **Nothing switches behind your back.** No automatic key detection, no paid upgrade, no fallback to another backend or mode. Retries stay on the same provider, the same mode and the same credential.
- **Failures are reported, not hidden.** A partial failure returns the results that worked and names what failed; a total failure says the search failed instead of pretending there were no matches.
- **Keys live in DSH's credential store**, write-only — they are never shown on the page and never exported with the configuration.
- **Language and region** use fixed lists; the plugin translates them into whatever each provider expects, and providers that ignore those fields say so.
- Tencent WSA needs a JSON credential: `{"secretId":"...","secretKey":"..."}`.

## Development

```sh
npm install --ignore-scripts --legacy-peer-deps
npm run check
```

Design notes: [docs/PLAN.md](docs/PLAN.md). Verification status: [docs/VERIFICATION.md](docs/VERIFICATION.md).

## License

MIT.
