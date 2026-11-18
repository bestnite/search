# websearch-mcp

English | [中文](README.zh.md)

An MCP server for multi-backend web search, plus discussion reading for Reddit and X. Works with any
MCP client: Claude Code, Codex, DeepSeek Harness, or your own.

## Why another search server

Most MCP search servers pick a provider for you and hide what happens when it fails. This one does the
opposite: every backend has an explicit access mode, every access mode carries a cost tier, and a
failure comes back named instead of as an empty result. The model can also steer a single call —
parallel or single, which backends, how much of each source — so a cheap lookup does not cost the same
as a broad sweep.

## Install

```sh
npm install -g @nite07/websearch-mcp
websearch-mcp --print-config > ~/.config/websearch-mcp/config.json
```

`--print-config` writes a complete, valid configuration with every backend disabled except Keenable
and Reddit, which need no account.

## First search

1. Open `~/.config/websearch-mcp/config.json`.
2. Under `search.backends`, set `"enabled": true` on the providers you want. Anonymous tiers —
   Keenable, Exa, You.com, AnySearch, Parallel, Reddit — need nothing else.
3. Register the server with your MCP client (next section).
4. Ask the client to search. To see what is available without spending anything, call
   `list_backends` first: it reports each backend's modes, cost tier, enabled state and whether a
   credential is present. It never enables anything.

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

`--config <path>` works too when you would rather pass the file explicitly. Without either, the
server reads `~/.config/websearch-mcp/config.json`.

## Credentials

Credential names are fixed by search-core, not configuration fields: a backend id is uppercased with
hyphens turned into underscores, then suffixed with `_KEY`. So Brave is `DSH_SEARCH_BRAVE_KEY` and
Zhihu site search is `DSH_SEARCH_ZHIHU_SITE_KEY`.

Put them where your client can see them:

```json
{
  "mcpServers": {
    "websearch": {
      "command": "websearch-mcp",
      "env": {
        "WEBSEARCH_MCP_CONFIG": "/home/you/.config/websearch-mcp/config.json",
        "DSH_SEARCH_BRAVE_KEY": "…"
      }
    }
  }
}
```

If an environment value is absent, `credentials.<backend-id>` may hold the value itself inside the
config file. Values are literal strings: `${...}` is not expanded. Saved `credentialRef` fields are
discarded on load so a file can never redirect a lookup.

## Browser-backed search

Xiaohongshu answers only its own page runtime, so it reads through a browser container you host. Start
it from [packages/core/image](../core/image/README.md), sign in over VNC, then point the server at it:

```json
{
  "search": {
    "browser": {
      "endpoint": "ws://127.0.0.1:3000/ws",
      "statePath": "/path/to/search-browser/data/state.json",
      "timeoutMs": 60000,
      "maxConcurrentReads": 2
    },
    "backends": {
      "xiaohongshu": { "enabled": true, "mode": "browser" }
    }
  }
}
```

The endpoint token goes in `DSH_SEARCH_BROWSER_TOKEN`, or in `credentials.browser` inside the file.
`maxConcurrentReads` (1–8) caps how many reads run on the site at once; the default is a conservative
local value, not a site quota. `statePath` must be the file the container writes, otherwise every read
starts signed out. This server exposes Xiaohongshu search, not note reading.

## Tools

| Tool | What it does |
| --- | --- |
| `web_search` | Search across the enabled backends. Takes `query`, plus optional `mode`, `backends`, `allBackends`, `exclude`, `backend`, `compact` and `maxResults`. Anything that cannot be honoured is named in the report rather than silently dropped. |
| `read_thread` | Read one discussion, with the pictures a post carries returned as MCP image content (bounded by count, per-file size and a per-call budget, with every link listed): `source: "reddit"` for a post with its comment tree (`sort`, `limit`, `depth` caps), or `source: "x"` for a post with its replies (needs the X backend in session mode). Comment text is untrusted user content. |
| `list_backends` | Every backend with its modes, cost tier, enabled state and whether a credential is present. It never enables anything. |

`compact: true` returns URL, title and date only, which is usually the difference between a usable
context and a flooded one.

## Behaviour worth relying on

- **No fallback.** A backend uses the mode you selected, the credential you gave it and the endpoint in
  the config. Retries stay on the same provider and mode.
- **Failures are visible.** Partial failures return the sources that worked and name the ones that did
  not; total failures say the search failed. Failed calls are never cached.
- **Per-call strategy, saved config untouched.** `mode`, `backends` and `compact` apply to that one
  call, so a narrow lookup and a broad sweep can coexist without editing the file.
- **Reddit is anonymous by default.** No account needed; the adapter uses the same anonymous token the
  Android client obtains, because Reddit's public REST search answers 403 to anonymous callers.
- **X thread reading follows the site, not a scraper.** The adapter reads the operation the web app
  embeds in the post page and calls it directly, so it survives front-end releases without a
  transaction-id signer.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The client shows no tools | The server failed to start. Run `websearch-mcp --config <path>` by hand and read the error. |
| Every search fails | No backend is enabled. Call `list_backends`, then enable one and restart the client. |
| A keyed backend reports a missing credential | The environment variable is named after the backend id. Check the exact name with `list_backends`. |
| Xiaohongshu reports no endpoint | `search.browser.endpoint` is empty and the backend has none. |
| Xiaohongshu reports not signed in | The container's session expired. Sign in again over VNC; the next read reloads the state file. |

## Development

See [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md).

## License

MIT.

## Friends

- [LINUX DO](https://linux.do)
