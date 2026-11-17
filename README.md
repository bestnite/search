# websearch-mcp

An MCP server for multi-backend web search, plus discussion reading for Reddit and X, built on
[`@nite07/search-core`](https://git.nite07.com/nite/search-core). Works with any MCP client: Claude
Code, Codex, DSH, or your own.

## Why another search server

Most MCP search servers pick a provider for you and hide what happens when it fails. This one does the
opposite: every backend has an explicit access mode, every access mode carries a cost tier, and a
failure comes back named instead of as an empty result. The model can also steer each call — parallel
or single, which backends, how much of each source — so a cheap lookup does not cost the same as a
broad sweep.

## Install

```sh
npm install -g @nite07/websearch-mcp
websearch-mcp --print-config > ~/.config/websearch-mcp/config.json
```

Then edit that file: enable the backends you want. Anonymous tiers (Keenable, Exa, You.com,
AnySearch, Parallel, Reddit) need no account at all. Credentials are read from fixed environment names first, for example
`DSH_SEARCH_KEENABLE_KEY`, `DSH_SEARCH_REDDIT_KEY` and `DSH_SEARCH_X_KEY`. Backend ids
are uppercased and hyphens become underscores. These names are defined by search-core,
not configurable fields. Set them in the MCP client's `env` block or the process environment.

If an environment value is absent, `credentials.<backend-id>` may contain the credential value
itself. Values are literal strings: `${...}` is not an environment reference and is not expanded.
Old `credentialRef` fields in saved search settings are discarded when loading the file.

Browser-backed searches use `search.browser.endpoint` and the single `DSH_SEARCH_BROWSER_TOKEN`
environment variable, or the literal `credentials.browser` value when that variable is absent.
The token authenticates the browser connection; site sign-in happens in the browser through VNC.
A token stored under `credentials.xiaohongshu` is not used. This server currently exposes
Xiaohongshu search, but not a Xiaohongshu note-reading tool.

## Client configuration

```json
{
  "mcpServers": {
    "websearch": {
      "command": "websearch-mcp",
      "env": { "WEBSEARCH_MCP_CONFIG": "/home/you/.config/websearch-mcp/config.json" }
    }
  }
}
```

`--config <path>` also works when you would rather pass the file explicitly.

## Tools

| Tool | What it does |
| --- | --- |
| `web_search` | Search across the enabled backends. Takes `query`, plus optional `mode`, `backends`, `allBackends`, `exclude`, `backend`, `compact` and `maxResults`. Anything that cannot be honoured is named in the report rather than silently dropped. |
| `read_thread` | Read one discussion, with the pictures a post carries returned as MCP image content (bounded by count, per-file size and a per-call budget, with every link listed): `source: "reddit"` for a post with its comment tree (`sort`, `limit`, `depth` caps), or `source: "x"` for a post with its replies (needs the X backend in session mode). Comment text is untrusted user content. |
| `list_backends` | Every backend with its modes, cost tier, enabled state and whether a credential is present. It never enables anything. |

## Behaviour worth relying on

- **No fallback.** A backend uses the mode you selected, the credential you gave it, and the endpoint in
  the config. Retries stay on the same provider and mode.
- **Failures are visible.** Partial failures return the sources that worked and name the ones that did
  not; total failures say the search failed. Results are never cached from a failed call.
- **Compact is a real lever.** `compact: true` returns URL, title and date only, which is usually the
  difference between a usable context and a flooded one.
- **Reddit default is anonymous.** No account needed; the adapter uses the same anonymous token the
  Android client obtains, because Reddit's public REST search answers 403 to anonymous callers.
- **X thread reading follows the site, not a scraper.** The adapter reads the operation the web app
  embeds in the post page and calls it directly, so it survives front-end releases without a
  transaction-id signer; a stale operation id is rediscovered once before failing.

## Development

```sh
npm install
npm run check     # typecheck, tests, build
node dist/main.js --config ./config.json
```

## License

MIT.
