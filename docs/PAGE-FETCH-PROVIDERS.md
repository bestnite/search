# Page Fetch: Provider Evidence

Status: implementation record for [PAGE-FETCH-DESIGN.md](PAGE-FETCH-DESIGN.md). Evidence date: 2026-11-18.

Every provider exposes two fetch access modes: a **keyless MCP mode** and a **keyed REST mode**. The
keyless modes were observed live from this checkout as described below. The keyed modes were
implemented from each provider's official API documentation and **were not called live**: this
deployment holds no provider API key and no authorization to spend on one. They are marked
`evidence: documented` in the catalog with their own date, and the settings page labels them
"documented only, no live call". No paid credit, no stored profile credential and no deployment
configuration was used for anything recorded here.

## What was required

A provider adapter is only added when its contract can be read from official documentation. A keyless
mode additionally had to be observed live; mock fixtures do not count. A keyed mode is accepted as
documented-only evidence when the contract is complete enough to implement, and it has to carry that
evidence state wherever it is shown rather than inheriting the "verified" label of the keyless mode.
The design targets two providers and allows a Markdown-only capability, because the engine records a
format capability skip instead of inventing content.

## Selected providers

| Provider | Catalog id | Mode | Transport | Endpoint | Native output | Target status | Title | Evidence |
|---|---|---|---|---|---|---|---|---|
| Exa | `exa` | `anonymous` | MCP tool `web_fetch_exa` | `https://mcp.exa.ai/mcp` | Markdown | not reported | not reported | live, 2026-11-18 |
| Exa | `exa` | `key` | REST `POST /contents` | `https://api.exa.ai/contents` | Markdown | `statuses[].error.httpStatusCode` | `results[].title` | documented, 2026-11-18 |
| Parallel | `parallel` | `anonymous` | MCP tool `web_fetch` | `https://mcp.parallel.ai/mcp` | Markdown | reported on failure | reported | live, 2026-11-18 |
| Parallel | `parallel` | `key` | REST `POST /v1/extract` | `https://api.parallel.ai/v1/extract` | Markdown | `errors[].http_status_code` | `results[].title` | documented, 2026-11-18 |

Both providers already exist as search providers in this workspace, so no new provider concept,
credential name or catalog entry was introduced: the fetch operation is attached to the existing
record, and the keyed mode resolves the same fixed credential reference as the provider's search mode.

The transport is part of the operation metadata, per access mode: `mcp` is one JSON-RPC tool call,
`rest` is the provider's documented HTTP operation. The engine reads the transport from the saved
access mode and passes it to the provider route; it never guesses a transport from an endpoint shape,
and a mode with no adapter for its transport is refused instead of being rerouted.

## Exa

### Anonymous MCP mode (live)

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
- Limits: the catalog already records that keyless Exa needs a direct IPv4 path and answers 403
  through proxies or IPv6. Free-tier rate limits are not published.

### Keyed REST mode (documented only)

- Contract: [Exa OpenAPI spec](https://github.com/exa-labs/openapi-spec/blob/master/exa-openapi-spec.yaml)
  (`servers: https://api.exa.ai`, `POST /contents`, schemas `ContentsRequest` / `ContentsResponse`,
  security scheme `apiKey` in the `x-api-key` header), quickstart
  [Contents](https://exa.ai/docs/contents/quickstart), pricing [Contents](https://exa.ai/products/contents).
- Request: `POST https://api.exa.ai/contents`, header `x-api-key: <stored exa credential>`,
  `Content-Type: application/json`, body
  `{"urls": [<target url>], "text": {"maxCharacters": <the fetch maxCharacters option>}}`.
  `text` accepts a boolean or an object; the object form is what bounds the representation.
- Response: `results[0].text` is Markdown and is labelled `provider-markdown` — it is native
  Markdown and is never reconverted. `results[0].title` is captured when present, `results[0].url`
  becomes the final URL. `statuses[0].status` is `success` or `error`; on `error`,
  `statuses[0].error.httpStatusCode` is the **target's** HTTP status (the API itself answered 200)
  and `statuses[0].error.tag` may carry a machine code, which is kept as a short note.
- Why HTML stays unsupported: the spec's `includeHtmlTags` option returns "lightweight HTML tags in
  returned text instead of plain markdown-style text" — that is tagged Markdown text, not a page HTML
  document. The adapter never sends it, and `format: 'html'` remains an `unsupported-format` preflight
  skip with no request sent.
- Cost: text is documented at $1/1,000 pages. The catalog's mode-level note carries this, and the
  card says the keyed mode is documented-only.
- Errors: `401` is an authentication failure; `402` is an exhausted balance or spending budget for an
  API-key request (the spec describes the x402 payment challenge only for requests without a key, and
  this adapter always sends one); `429` is rate limiting; any other non-2xx is an HTTP failure. The
  response body is never read into a message, and the key is never echoed.

## Parallel

### Anonymous MCP mode (live)

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
- Limits: anonymous free tier, numeric quota not published; the MCP caps excerpts per call at roughly
  25,000 characters according to its docs.

### Keyed REST mode (documented only)

- Contract: [Extract API reference](https://docs.parallel.ai/api-reference/extract/extract.md)
  (OpenAPI `POST /v1/extract`, security scheme `ApiKeyAuth` in the `x-api-key` header, schemas
  `V1ExtractRequest` / `V1ExtractResponse`), quickstart
  [Extract](https://docs.parallel.ai/extract/extract-quickstart), pricing
  [Parallel pricing](https://docs.parallel.ai/getting-started/pricing).
- Endpoint choice: the GA path is `/v1/extract`. Parallel's own documentation index states that
  `/v1/search` and `/v1/extract` are for all new integrations and that `/v1beta/*` exists only for
  existing integrations; the request bodies differ too — on `/v1/extract`, `full_content`,
  `fetch_policy` and `excerpt_settings` live inside `advanced_settings`, and the v1beta top-level form
  answers 422. This adapter posts the GA shape:
  `POST https://api.parallel.ai/v1/extract`, header `x-api-key: <stored parallel credential>`,
  `Content-Type: application/json`, body
  `{"urls": [<target url>], "advanced_settings": {"full_content": <<the fetch full_content option>}}`.
- Response: `results[0].full_content` is Markdown and is labelled `provider-markdown` (kept verbatim);
  `results[0].title` is the title; `results[0].url` becomes the final URL. When `full_content` is
  turned off, the adapter falls back to `results[0].excerpts` joined as Markdown, exactly like the
  MCP mode, and says so through the option's own help text.
- Target status: `errors[0].http_status_code` is the target's status while the API answered 200;
  `errors[0].error_type` is kept as a short note and `errors[0].content` is never echoed.
- Why HTML stays unsupported: Extract returns Markdown content only; there is no HTML document in the
  contract. `format: 'html'` stays an `unsupported-format` preflight skip.
- Cost: $1 per 1,000 URLs. Documented rate limit: 600 requests per minute.
- Errors: `401` authentication; `402` balance or spending-budget exhaustion; `429` rate limiting; any
  other non-2xx is an HTTP failure. Only `200` and `422` are enumerated on the operation itself in the
  published reference, so the 401/402/429 mapping follows this project's shared transport
  classification rather than a live observation of each envelope.

## Error mapping shared by both keyed modes

`401` → `authentication`; `402` → the quota/balance kind; `429` → the rate-limit kind; any other
non-2xx → the HTTP kind. The provider API status is preserved on the attempt as `apiStatus`, separate
from the target status (`statusCode`). The provider's error body is never read into a message, a note
or a diagnostic, and the stored key never appears in any user-visible string. A missing key is refused
before any request is built: the engine reports a configuration failure, and the provider transport
independently refuses to build the request, so an unauthenticated call cannot be sent by accident.

## The credential is the search credential

Fetching reuses `backendCredentialRef(providerId)` — the same fixed reference the provider's search
mode uses (`DSH_SEARCH_<ID>_KEY`). There is no second key, no fetch-only credential and no second input
box: the fetch card shows configured/not-configured and links to the single credential control on the
search card. Switching a provider between keyless and keyed fetching therefore never asks the user to
enter the same secret twice.

## What is not verified

- **No live keyed call was made, for either provider.** The keyed modes are implemented from the
  official documentation listed above. Their request shapes, response field names and error-status
  semantics are contract-tested against fixtures built from that documentation, not from a real
  response.
- Nothing here proves the keyed endpoints accept this exact request today: field names, nesting
  (`text` object for Exa, `advanced_settings` for Parallel) and header names could have drifted from
  the published spec, and only a live call would catch that.
- The documented error envelopes for `401`/`402`/`429` were not observed on either keyed endpoint;
  only their classification is implemented.
- Exa's `statuses[0].error.tag` vocabulary and Parallel's `error_type` vocabulary are not enumerated
  in the contracts; both are only passed through as a sanitized short note.
- Whether `full_content: false` returns `full_content: null` or omits the field was not observed; the
  adapter handles both, and the excerpt fallback path is covered only by fixtures.
- Latency, real-world extraction quality and the effect of JavaScript-heavy pages in the keyed modes
  are unknown here.
- Billing was not exercised: the documented prices ($1/1,000 pages for Exa text, $1/1,000 URLs for
  Parallel Extract) are quoted, not measured.

## Rejected candidate

- `you` (`https://api.you.com/mcp`) answers `Unauthorized: OAuth authentication required` to an
  anonymous client, which contradicts the older free-MCP note in the search catalog. No adapter was
  added; nothing in its search behavior was changed.

## Consequences recorded in the design

- Both providers are Markdown-only in both modes. A caller asking for `html` gets an
  `unsupported-format` attempt with **no request sent**, and the chain continues to the next enabled
  route. There is no invented HTML and no second provider call.
- No provider fetch mode returns HTML, so `format: 'html'` can only be served by the HTTP or browser
  routes in this release. That is a documented coverage limit, not a silent downgrade.
- Credential reuse: fetching uses the same fixed credential name as searching
  (`DSH_SEARCH_<ID>_KEY`) through the same resolver. Keyless modes need none. The fetch endpoint,
  transport and options are stored separately, because sharing a provider does not imply sharing an
  endpoint.
- A keyed fetch mode with no stored key is a configuration failure before any route runs; the
  settings page reports the same fact as a readiness problem before a test is even attempted.
- Only the target URL is sent to a provider. Browser cookies, rendered HTML and local session state
  are never forwarded.
