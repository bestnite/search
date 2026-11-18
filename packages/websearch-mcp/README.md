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
mkdir -p ~/.config/websearch-mcp
websearch-mcp --print-config > ~/.config/websearch-mcp/config.json
```

This creates the initial settings with Keenable and Reddit enabled; neither needs an account.
You do not need to edit the generated file. Use the settings page or ask your agent to make changes.

## Connect your MCP client

Add a **stdio** MCP server in your client's MCP settings:

| Field | Value |
| --- | --- |
| Name | `websearch` |
| Command | `websearch-mcp` |
| Arguments | None |

The command must be available to the client. If it cannot find it, use the full path to the installed
executable. Clients that only accept a configuration file have their own setup format; follow that
client's instructions for adding a stdio server.

## First search

Ask your agent to search using the default backends, or ask it to list the available providers first.
For example: “Search for recent self-hosting news using Keenable and Reddit.”

To choose providers, check costs or change search preferences, use the settings page below or ask the agent to
manage the settings for you. There is no need to write configuration by hand.

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

## Credentials

Enter a provider's API key or account credential on its card in the settings page and save.
You can also authorize the agent to set or remove a credential with `search_manage`.
Credential values are never returned by that tool. Do not paste secrets into a shared conversation.

## Browser-backed search

Xiaohongshu search and note reading need a browser container:

1. Start the [browser container](../core/image/README.md) and sign in to Xiaohongshu over VNC.
2. In the settings page's **Browser** section, enter the endpoint and endpoint token shown by the
   container. If you use a saved session file, enter its path there too.
3. Enable Xiaohongshu in browser mode in **Backends** and save.

Then ask your agent to search Xiaohongshu or read a full share link copied from the app.

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

For example: “Show me the available free backends, enable Keenable, and save.”
Tests make real requests and may incur charges. Configuration changes, credential changes and tests
require your authorization.

## Page fetching

Enable **web_extract** in the settings page's **Page fetch** section, or ask the agent to enable it.
Then ask it to read a URL as Markdown, or return HTML when you need the page structure.

Browser support is available for JavaScript pages. You can choose a fetch provider on the same page;
check its supported formats and costs, and supply an API key if required. Public URLs are allowed by
default.

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
| The client shows no tools | The server failed to start. Run `websearch-mcp` in a terminal and read the startup error. |
| Every search fails | No backend is enabled. Enable one in the settings page or ask the agent to enable it, then retry. |
| A keyed backend reports a missing credential | Enter the credential on the provider card, or authorize the agent to set it. |
| Xiaohongshu reports no endpoint | Fill in the endpoint in the settings page’s Browser section. |
| Xiaohongshu reports not signed in | The container's session expired. Sign in again over VNC; the next read reloads the state file. |

## Development

See [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md).

## License

MIT.
