# websearch-mcp

An MCP server for multi-backend web search, plus discussion reading for Reddit, built on
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
AnySearch, Parallel, Reddit) need no account at all. Credentials are read from the environment first,
so `"credentials": { "keenable": "${NITE_SEARCH_KEENABLE_KEY}" }` keeps the secret out of the file.

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
| `read_thread` | Read one Reddit post with its comment tree: `url` or `postId`, with `sort`, `limit` and `depth` caps. Comment text is untrusted user content. |
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

## Development

```sh
npm install
npm run check     # typecheck, tests, build
node dist/main.js --config ./config.json
```

## License

MIT.
