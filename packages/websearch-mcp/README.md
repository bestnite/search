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
failure comes back named instead of as an empty result. The model can also steer a single call — which
backends, how much of each source — so a cheap lookup does not cost the same as a broad sweep. How many
run is the caller's decision: one id in `backends` runs one backend, several run in parallel.

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
3. Register the server with your MCP client (see **Client configuration**).
4. Ask the client to search. To see what is available without spending anything, call
   `list_backends` first: it reports each backend's modes, cost tier, enabled state and whether a
   credential is present. It never enables anything.

## Search results

Each result names the backends that found it, including multiple sources for the same page.
The response also shows which backends were used and whether it came from the cache.

## Settings page

Use the settings page to choose backends, check costs, enter credentials and test your setup:

```sh
WEBSEARCH_MCP_UI_PORT=7799 WEBSEARCH_MCP_UI_TOKEN=replace-with-a-long-random-token websearch-mcp
```

Open `http://127.0.0.1:7799/?token=replace-with-a-long-random-token`. The page is available while the MCP server is running.
Set `WEBSEARCH_MCP_UI_HOST` if you need a different bind address. Without a token, the page is open;
set one before exposing it beyond your machine.

The page has sections for search, reliability, diagnostics, backends, browser setup and page fetching.
Saved changes take effect on the next call, without restarting the server. Invalid changes are
rejected; recent configuration backups are kept automatically.

To run only the settings page:

```sh
websearch-mcp --ui --port 7799 --token replace-with-a-long-random-token
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
config file. Values are literal strings: `${...}` is not expanded.

## Browser-backed search

Xiaohongshu search and note reading need a browser container. Start
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
Set `statePath` to the container's saved session file. `maxConcurrentReads` (1–8) controls concurrent
reads on the same site.

To read a note, pass its full share link from the app, or a note id returned by an earlier search,
to `xiaohongshu_note`.

## Tools

| Tool | What it does |
| --- | --- |
| `web_search` | Search selected backends with `query`. Optional: `backends`, `allBackends`, `exclude`, `compact`, `maxResults`. One backend id searches only that backend; omitting the selection searches every enabled backend. |
| `reddit_thread` | Read a Reddit post, comments and pictures. |
| `x_thread` | Read an X post, replies and pictures. Requires the X backend in session mode. |
| `xiaohongshu_note` | Read a note's text, author, engagement, tags and pictures, with optional comments. Requires the Xiaohongshu backend in browser mode and a configured browser. |
| `list_backends` | List available backends, access modes, costs, enabled state and credential readiness. |
| `search_manage` | Inspect or change settings and credentials, test a backend, or test page fetching. |
| `web_extract` | Read one page as Markdown or HTML. Disabled by default; enable it in **Page fetch**. |

`compact: true` omits snippets while keeping links, titles, dates and backend provenance.

The former `read_thread` tool has been replaced by `reddit_thread` and `x_thread`; update existing
calls to use the platform's tool without a `source` argument.

## Agent settings management

Ask the agent to use `search_manage` to view settings, change backends or page-fetch options, and
set or remove credentials. It can also test a saved backend or page-fetch setup. Credential values
are never returned. Changes take effect without restarting the MCP server.

The agent should read settings first (`action: "settings"`), then submit the complete edited config
with its `expectedRevision` (`action: "save"`). Credential changes also require that revision.
Actions `test` and `fetch-test` run real requests and may incur charges. Configuration changes,
credential changes and tests require your authorization.

## Page fetching

Use `web_extract` to read a known URL as Markdown or HTML. Enable it in the settings page, or set
`search.tools.webExtract` to `true` in the configuration file.

```json
{ "url": "https://example.com/article", "format": "markdown" }
```

Use `"html"` when you need the page structure. Browser support is available for JavaScript pages.
You can choose a fetch provider in **Page fetch**; check its supported formats and costs, and supply
an API key if required. Page fetching allows public URLs by default.

## Behaviour worth relying on

- **No fallback.** A backend uses the mode you selected, the credential you gave it and the endpoint in
  the config. Retries stay on the same provider and mode.
- **Failures are visible.** Partial failures return the sources that worked and name the ones that did
  not; total failures say the search failed. Failed calls are never cached.
- **Per-call strategy, saved config untouched.** `backends`, `exclude` and `compact` apply to that one
  call, so a narrow lookup and a broad sweep can coexist without editing the file.
- **Reddit is anonymous by default.** No account is needed.
- **X discussions include replies.** Use session mode with valid account cookies.

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
