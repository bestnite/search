# websearch-mcp

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/@nite07/websearch-mcp?label=npm&style=flat-square&color=cb3837)](https://www.npmjs.com/package/@nite07/websearch-mcp)
[![downloads](https://img.shields.io/npm/dm/@nite07/websearch-mcp?label=downloads&style=flat-square&color=cb3837)](https://www.npmjs.com/package/@nite07/websearch-mcp)

An MCP server for multi-backend web search, plus discussion reading for Reddit and X and note reading
for Xiaohongshu. Works with any
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

## Settings page

The configuration has a page: every backend, its access mode, its cost tier, its options and its
credential in one form, plus a probe button per backend. **The MCP server serves it itself** — one
process, no extra unit, container or port-forwarder to install:

```sh
WEBSEARCH_MCP_UI_PORT=7799 WEBSEARCH_MCP_UI_TOKEN=... websearch-mcp   # stdio client + page
```

- `WEBSEARCH_MCP_UI_PORT` turns the page on for that process; `WEBSEARCH_MCP_UI_HOST` picks the bind
  address (default `127.0.0.1`, so a client on the same machine needs nothing else).
- The page lives exactly as long as the server does. When the client closes stdin the process exits
  and the port is released, which also means a client that respawns the server gets a fresh page.
- A port that cannot be bound is reported on stderr and the MCP tools carry on: a page is never a
  reason to lose the tools.
- **Authentication is on only when a token is supplied, and the token comes from the environment or
  the command line — this server never writes one to disk.** `--no-token` (page-only mode) or
  `WEBSEARCH_MCP_UI_TOKEN` (any mode) decides it; with neither, the page is open and the log says so.
- With a token the first request carries `?token=`, exchanged for an `HttpOnly`, `SameSite=Strict`
  cookie, so the link does not stay in browser history.
- Saving validates against the same schema the server enforces. A rejected save leaves the file
  untouched and lists every problem by path; an accepted one writes `config.json.bak-<local time>`
  (five kept) and replaces the file atomically at mode 0600. The server watching that file reloads
  immediately, so the next `web_search` already uses what the page saved.
- A file that stops parsing keeps the previous configuration and says why on stderr.
- When a `config.container.json` sits beside the file, every save rewrites it too: loopback endpoints
  become `host.containers.internal`, and the browser session file is mapped into `/host/home`. The
  companion is never created on its own.

Page without an MCP client, for a quick look:

```sh
websearch-mcp --ui --host 0.0.0.0 --port 7799 --print-url   # --print-url prints the links and exits
```

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
starts signed out.

Searching needs only the endpoint. Reading a note goes through the same browser, so the backend
must be enabled in browser mode; `xiaohongshu_note` then takes the share link from the app (it
carries the token the read needs) or a note id an earlier search returned.

## Tools

| Tool | What it does |
| --- | --- |
| `web_search` | Search across the enabled backends. Takes `query`, plus optional `mode`, `backends`, `allBackends`, `exclude`, `backend`, `compact` and `maxResults`. Anything that cannot be honoured is named in the report rather than silently dropped. |
| `read_thread` | Read one discussion, with the pictures a post carries returned as MCP image content (bounded by count, per-file size and a per-call budget, with every link listed): `source: "reddit"` for a post with its comment tree (`sort`, `limit`, `depth` caps), or `source: "x"` for a post with its replies (needs the X backend in session mode). Comment text is untrusted user content. |
| `xiaohongshu_note` | Read one note: text, author, engagement counts, tags, pictures as image
content, and optionally its top-level comments (depth is one level, `commentLimit` 1–50). Needs the
Xiaohongshu backend in browser mode plus a browser endpoint; a disabled backend, a missing endpoint
or a missing note token is reported instead of an empty note. |
| `list_backends` | Every backend with its modes, cost tier, enabled state and whether a credential is present. It never enables anything. |

`compact: true` returns URL, title and date only, which is usually the difference between a usable
context and a flooded one.

## Protocol versions

The wire protocol is the [official TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/)
(`@modelcontextprotocol/server`), not a hand-written loop: the server answers the stateless
`2026-07-28` revision and falls back to the 2025 handshake for clients that still open with
`initialize`. A protocol revision therefore reaches this package as a dependency bump.

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
