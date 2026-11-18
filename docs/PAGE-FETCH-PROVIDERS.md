# Page Fetch: Provider Evidence

Status: implementation record for [PAGE-FETCH-DESIGN.md](PAGE-FETCH-DESIGN.md). Evidence date: 2026-11-18.
All observations below come from this checkout's own anonymous trials; no paid credit, no stored
profile credential, and no deployment configuration was used.

## What was required

A provider adapter is only added when its contract can be read from official documentation **and**
its anonymous schema was observed live. Mock fixtures do not count. The design targets two verified
providers and allows a Markdown-only or HTML-only capability, because the engine records a format
capability skip instead of inventing content.

## Selected providers

| Provider | Catalog id | MCP endpoint | Fetch tool | Native output | Target status | Title |
|---|---|---|---|---|---|---|
| Exa | `exa` | `https://mcp.exa.ai/mcp` | `web_fetch_exa` | Markdown | not reported | not reported |
| Parallel | `parallel` | `https://mcp.parallel.ai/mcp` | `web_fetch` | Markdown (token-efficient) | reported on failure | reported |

Both are already search providers in this workspace, so no new provider concept, credential name or
catalog entry was introduced: the fetch operation is attached to the existing record.

### Exa

- Operation docs: [Exa MCP](https://exa.ai/docs/get-started/exa-mcp); tool list in the
  [exa-mcp-server README](https://github.com/exa-labs/exa-mcp-server). `web_fetch_exa` is a default
  tool, not an optional one.
- Request observed: `{"urls": [url], "maxCharacters": 50000}` — `urls` required, `maxCharacters`
  optional with a provider default of 3000. The adapter sends one URL per request; batching many URLs
  is outside v1 (single-URL fetch by design).
- Success shape observed: one text block whose content is Markdown-like text, with a `# Title` line
  and `URL: …` line prepended by the provider. The provider reports no target HTTP status and no
  metadata object, so the engine records `title` and `status` as unavailable, never as inferred
  values. In particular the engine does **not** read the leading `#` line as a title.
- Failure shape observed: `isError: true` with text such as
  `Error fetching URL(s): <url>: CRAWL_NOT_FOUND`. There is no target status to report; the engine
  records a `provider-error` outcome with the provider API status (HTTP 200, since the MCP call
  itself succeeded) and only a short machine code such as `CRAWL_NOT_FOUND` in notes.
- Access: verified in `anonymous` mode only (keyless MCP). Key-mode fetch has no verified endpoint
  and is therefore not selectable for fetching; the access mode list stays `['anonymous']`.
- Limits: the catalog already records that keyless Exa needs a direct IPv4 path and answers 403
  through proxies or IPv6. Free-tier rate limits are not published.

### Parallel

- Operation docs: [Parallel MCP quickstart](https://docs.parallel.ai/integrations/mcp/quickstart)
  and the [Parallel MCP 2.0 announcement](https://parallel.ai/blog/parallel-mcp-2), which lists
  `web_fetch` as free and account-free. The older
  [Search MCP page](https://docs.parallel.ai/integrations/mcp/search-mcp) documents the same
  `web_fetch` tool on the legacy endpoint.
- Request observed: `{"urls": [url], "full_content": true}` — `urls` required; `objective`,
  `search_queries` and `full_content` optional. This adapter asks for full content because a page
  fetch is meant to return the page, not LLM-selected excerpts.
- Success shape observed: `structuredContent` (also mirrored as JSON text) with
  `results[0] = {url, title, publish_date, excerpts[], full_content, acquired_at}`. The adapter takes
  `full_content` as native Markdown, `title` as metadata, and the resolved `url` as the final URL.
  No target status is reported on success, so it stays unavailable.
- Failure shape observed for a missing page: `isError: false`, `results: []`,
  `errors: [{url, error_type: "http_error", http_status_code: 404, content: null}]`. The provider API
  answered HTTP 200 while the target answered 404; the engine keeps these apart and records target
  `statusCode: 404` with a target-status outcome.
- Access: verified anonymous. The same rule applies: only `anonymous` is selectable for fetching.
- Limits: anonymous free tier, numeric quota not published; the MCP caps excerpts per call at roughly
  25,000 characters according to its docs.

## Rejected candidate

- `you` (`https://api.you.com/mcp`) now answers `Unauthorized: OAuth authentication required` to an
  anonymous client, which contradicts the older free-MCP note in the search catalog. No adapter was
  added; the existing search behavior was left untouched because this change is scoped to fetching.

## Consequences recorded in the design

- Both providers are Markdown-only. A caller asking for `html` gets an `unsupported-format` attempt
  with **no request sent**, and the chain continues to the next enabled route. There is no invented
  HTML and no second provider call.
- No provider fetch operation returns HTML, so `format: 'html'` can only be served by the HTTP or
  browser routes in this release. That is a documented coverage limit, not a silent downgrade.
- Credential reuse: fetching uses the same fixed credential name as searching
  (`DSH_SEARCH_<ID>_KEY`) through the same resolver. Anonymous providers need none. The fetch
  endpoint, timeout and options are stored separately, because sharing a provider does not imply
  sharing an endpoint.
- Only the target URL is sent to a provider. Browser cookies, rendered HTML and local session state
  are never forwarded.
