# Page Fetch: Provider Evidence

Status: implementation record for [PAGE-FETCH-DESIGN.md](PAGE-FETCH-DESIGN.md). Evidence date: 2026-11-18.
Batch 2 (this document's update) adds nine providers to the two that shipped first.

Every fetch mode declares its own transport, endpoint, evidence and cost. A **keyless** mode is only
called `live` when this deployment actually exercised it anonymously; a **keyed** mode is
`documented` — implemented from the provider's official contract, no call made, because this
deployment holds no provider API key and no authorization to spend on one. No paid credit, no stored
profile credential and no deployment configuration was used for anything recorded here.

## What was required

A provider adapter is only added when its contract can be read from official documentation, and a
keyless mode additionally had to be observed live; mock fixtures do not count. The contract has to
say, unambiguously: the endpoint, the method, the auth header, the request fields, the response
fields, which format the content really comes back in, whether any target status is reported, and what
a call costs. A field name is never guessed: if the documentation did not name it, the adapter does
not read it.

Three further rules hold for every provider added in batch 2:

- **Transport per mode, not per provider.** `mcp` is one JSON-RPC tool call on a documented MCP tool;
  `rest` is the provider's documented HTTP operation. Keenable documents a GET-with-query operation,
  and the shared REST transport grew an explicit GET form for exactly that instead of sending a POST
  the provider never documented.
- **`serves` is what the response really is.** A provider that returns Markdown or plain text cannot
  serve HTML, and the engine skips an HTML request with no request sent. A provider that can return
  the page's own HTML (Serpex `format: html`, You.com `full_page.extraction_formats: ["html"]`,
  Linkup `includeRawContent`) really returns that HTML for an HTML request; text is never wrapped as
  markup.
- **Cost is mode metadata.** Pricing and quota text lives on the mode, not in prose, so the settings
  page shows what a mode spends before it is enabled.

## Evidence at a glance

| Provider | Catalog id | Mode | Transport | Endpoint | Native output | Target status | Title | Evidence |
|---|---|---|---|---|---|---|---|---|
| Exa | `exa` | `anonymous` | MCP tool `web_fetch_exa` | `https://mcp.exa.ai/mcp` | Markdown | not reported | not reported | live, 2026-11-18 |
| Exa | `exa` | `key` | REST `POST /contents` | `https://api.exa.ai/contents` | Markdown | `statuses[].error.httpStatusCode` | `results[].title` | documented, 2026-11-18 |
| Parallel | `parallel` | `anonymous` | MCP tool `web_fetch` | `https://mcp.parallel.ai/mcp` | Markdown | reported on failure | reported | live, 2026-11-18 |
| Parallel | `parallel` | `key` | REST `POST /v1/extract` | `https://api.parallel.ai/v1/extract` | Markdown | `errors[].http_status_code` | `results[].title` | documented, 2026-11-18 |
| DeepSeek | `deepseek` | `key` | REST `POST /v1/tools/fetch` | `https://api.deepseek.com/v1/tools/fetch` | Markdown | not reported | `title` | documented, 2026-11-18 |
| Serpex | `serpex` | `key` | REST `POST /api/crawl` | `https://api.serpex.dev/api/crawl` | Markdown or full page HTML | `results[].status_code` | not reported | documented, 2026-11-18 |
| Linkup | `linkup` | `key` | REST `POST /v1/fetch` | `https://api.linkup.so/v1/fetch` | Markdown; HTML via `rawContent` | not reported | not reported | documented, 2026-11-18 |
| Tavily | `tavily` | `anonymous` | REST `POST /extract` + keyless header | `https://api.tavily.com/extract` | Markdown or plain text | not reported | `results[].title` (live answer) | live, 2026-11-18 |
| Tavily | `tavily` | `key` | REST `POST /extract` | `https://api.tavily.com/extract` | Markdown or plain text | not reported | `results[].title` | documented, 2026-11-18 |
| You.com | `you` | `key` | REST `POST /v1/extract` | `https://ydc-index.io/v1/extract` | Markdown and/or HTML | not reported | `title` | documented, 2026-11-18 |
| Keenable | `keenable` | `anonymous` | REST `GET /v1/fetch/public` + title header | `https://api.keenable.ai/v1/fetch/public` | Markdown | not reported | `title` | live, 2026-11-18 |
| Keenable | `keenable` | `key` | REST `GET /v1/fetch` | `https://api.keenable.ai/v1/fetch` | Markdown | not reported | `title` | documented, 2026-11-18 |
| AnySearch | `anysearch` | `anonymous` | REST `POST /v1/extract` | `https://api.anysearch.com/v1/extract` | cleaned text | not reported | `data.title` | live, 2026-11-18 |
| AnySearch | `anysearch` | `key` | REST `POST /v1/extract` + Bearer | `https://api.anysearch.com/v1/extract` | cleaned text | not reported | `data.title` | documented, 2026-11-18 |
| Doubao | `doubao` | `key` | REST `POST /search_api/fetch` | `https://open.feedcoopapi.com/search_api/fetch` | plain text (≤50,000 chars) | `Result.Data.StatusCode` | `Result.Data.Title` | documented, 2026-11-18 |
| open-websearch | `open-websearch` | `anonymous` | REST `POST /fetch-web` | `http://127.0.0.1:3210/fetch-web` | extracted text | not reported | `data.title` (may be empty) | documented, 2026-11-18 |

Every provider already exists as a search provider in this workspace, so no new provider concept,
credential name or catalog entry was introduced: the fetch operation is attached to the existing
record, and a keyed mode resolves the same fixed credential reference as the provider's search mode.

## What this deployment actually called

Three anonymous probes were run from this checkout on 2026-11-18, and one was attempted. They are the
only live evidence in this document. Their exact shape is recorded here because the fixtures in the
test suite are built from the documentation, not from these answers.

1. **Keenable public fetch** —
   `curl -G https://api.keenable.ai/v1/fetch/public -H 'X-Keenable-Title: dsh-search' --data-urlencode 'url=https://example.com'`
   answered `HTTP/2 200` with
   `{"url":"https://example.com/","title":"Example Domain","content":"This domain is for use in documentation examples…","description":"","truncated":false,"total_chars":156}`
   and the headers `x-ratelimit-limit: 1000`, `x-ratelimit-remaining: 999`,
   `x-ratelimit-reset: 2026-11-18T13:00:05.199Z`. No `usage` object: the public path charges nothing.
2. **Tavily keyless extract** —
   `curl -X POST https://api.tavily.com/extract -H 'X-Tavily-Access-Mode: keyless' -d '{"urls":["https://example.com"],"format":"markdown"}'`
   answered `HTTP/2 200` with
   `{"results":[{"url":"https://example.com","title":"Example Domain","raw_content":"This domain is for use in documentation examples…","images":[]}],"failed_results":[],"response_time":…,"request_id":"…"}`.
   No credential was sent.
3. **AnySearch extract** —
   `curl -X POST https://api.anysearch.com/v1/extract -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'`
   answered `HTTP/2 200` with
   `{"code":0,"message":"success","request_id":"…","data":{"url":"https://example.com","title":"Example Domain","content":"This domain is for use in documentation examples…"}}`
   and the headers `x-ratelimit-limit: 10`, `x-ratelimit-remaining: 8`. No credential was sent.
4. **open-websearch local daemon** — `curl --noproxy '*' http://127.0.0.1:3210/health` failed with
   `curl: (7) Failed to connect to 127.0.0.1:3210 after 0 ms: Could not connect to server`. No daemon
   answered, so this mode has no live evidence and was not exercised.

The keyless Exa and Parallel MCP modes were observed live in the batch that shipped them; that
observation is recorded further down and is why their anonymous modes carry the operation's live date.

## DeepSeek

- Contract: [Search & Fetch guide](https://api-docs.deepseek.com/guides/search/) (Fetch API section)
  and the Fetch API reference: `POST https://api.deepseek.com/v1/tools/fetch`, `Authorization: Bearer
  <key>`, body `{"url": "<target>"}`, answer `{"title": "<page title, empty when unknown>", "content":
  "<page content as Markdown text>"}`.
- Request built by the adapter: the URL alone. No `count`, no character bound — the operation
  documents none, so none is sent.
- Response mapping: `content` is native Markdown and is returned verbatim; `title` is captured when
  non-empty; an empty title is unavailable, never an empty string. No target status exists in the
  contract, so the attempt leaves `statusCode` unset.
- Status separation: DeepSeek documents `404` as *"Fetch could not retrieve usable page content"* —
  the API's own answer about its fetch, not the target page's status. The adapter therefore never
  turns a 404 into a target `statusCode`; the API status stays on `apiStatus`.
- Cost and limits: $0.75 per 1,000 successful fetch requests; a failed request, an empty result and a
  timeout are not billed. Fetch is limited to 25 QPS per account plus a per-domain limit; exceeding
  either answers `429`.
- Errors: `401` authentication, `402` insufficient balance, `403` refused by the security policy,
  `404` no usable page content, `429` QPS, `5xx` server side. OpenAI-compatible error bodies are never
  read into a message.

## Serpex

- Contract: [Extract API](https://serpex.dev/docs/api/extract) — `POST
  https://api.serpex.dev/api/crawl`, `Authorization: Bearer sk_…`, body `{"urls": [url], "format":
  "markdown" | "html"}`, answer `{success, results: [{url, success, markdown?, html?, status_code,
  error?, error_type?}], metadata}`.
- Response mapping: on `format: markdown` the adapter takes `results[0].markdown`; on `format: html`
  it takes `results[0].html`, which the provider documents as "the full rendered HTML of the page".
  Neither is ever converted into the other.
- Target status: `results[0].status_code` is the **target's** status while the API answered 200. A
  failed URL carries the same field, so the shared rule applies: 400 or above is a target HTTP
  failure with `statusCode` set, anything else is a provider-side failure. `error_type` values seen in
  the contract (`http`, `unsupported_content_type`, `too_large`, `robots_disallowed`) are kept as a
  sanitized note; the `error` text is never echoed.
- Cost: 1 credit per successfully extracted URL; the same organization repeating the same URL with
  the same `format` within 5 minutes is free (`metadata.cached_free`), and failed extractions are
  never charged. A request that times out answers `504` and is not charged.
- Errors: `401` authentication, `429` rate limit, `504` gateway timeout; any other non-2xx is an HTTP
  failure.

## Linkup

- Contract: [/fetch OpenAPI reference](https://docs.linkup.so/pages/documentation/endpoints/fetch/reference.md)
  and the [Fetch overview](https://docs.linkup.so/pages/documentation/endpoints/fetch/overview.md) —
  `POST https://api.linkup.so/v1/fetch`, `Authorization: Bearer <key>`, body `{"url", "mode",
  "renderJs", "includeRawContent"?}`, answer `{markdown (required), favicon (required), rawContent?,
  contentType?, images?, rawHtml? (deprecated), data?}`.
- Request: `mode` from the fetch option (`standard` or `pro`), `renderJs` from the fetch option
  (default `false`), and `includeRawContent: true` **only** on an HTML request. `includeRawHtml` is
  marked deprecated in the reference, so it is not sent.
- Response mapping: `markdown` is native Markdown and is returned verbatim. For an HTML request the
  adapter takes `rawContent` **only when `contentType` says it is HTML**; a non-HTML body (a PDF, for
  instance) is reported as `unsupported-content` rather than labelled as the page HTML. No title and
  no target status are in the contract, so both stay unavailable.
- Cost: $0.001 per call with `mode: standard` and no JavaScript rendering; $0.005 with `renderJs:
  true` or `mode: pro`; adding a `schema` for structured output costs $0.001 more. The adapter never
  sends `schema` or `instructions`, so a fetch is always markdown-or-raw only.
- Errors: `400` invalid parameters, `401` bad key, `402` payment required (the reference describes the
  x402 pay-per-request path for a request without a key — this adapter always sends one), `429` rate
  limit or insufficient credits.

## Tavily

- Keyless contract: [Try Tavily without an API key](https://docs.tavily.com/documentation/keyless.md) —
  send `X-Tavily-Access-Mode: keyless` on the normal endpoints, no account, no key; keyless responses
  use the same schema as keyed ones, and the two endpoints that support keyless are `/search` and
  `/extract`. Sending both the keyless header and a valid bearer key makes the **key** win, so the
  anonymous mode sends only the marker and the keyed mode sends only the key.
- Extract contract: [Extract reference](https://docs.tavily.com/documentation/api-reference/endpoint/extract.md)
  — `POST https://api.tavily.com/extract`, body `{"urls": [url], "format": "markdown" | "text",
  "extract_depth": "basic" | "advanced"}` plus options this adapter does not send.
- Response mapping: `results[0].raw_content` is returned as native Markdown when the format option is
  `markdown`, and as plain text (`text`, representation `response-text`) when the option is `text` —
  the two are not relabelled into each other. `results[0].url` is the final URL. No target status is
  in the contract.
- Live observation vs the published schema: the schema documents `url`, `raw_content`, `images`,
  `favicon` and `published_date`, but the live keyless answer also carried `results[0].title`. The
  adapter reads a title only when the field is a non-empty string, so it gains a title when the
  provider sends one and never invents one when it does not. This is recorded as an observation, not
  as a documented field.
- A URL the provider could not process appears in `failed_results`; the adapter reports a
  `provider-error` with a bounded note and never echoes the provider's error text. HTTP 200 can carry
  an empty `results` array, which is why both arrays are read.
- Cost: keyless access is free and rate-limited with no published number; keyed access gets 1,000 free
  credits/month, basic extraction is 1 credit per 5 successful URLs, advanced 2 credits per 5, and
  pay-as-you-go credits cost $0.008 each.
- **Adding this mode changes nothing about Tavily's search behaviour**: the search modes, search
  request and search UI are untouched; only a fetch access mode was added.

## You.com

- Contract: [Extract API reference](https://you.com/docs/api-reference/extract.md) —
  `POST https://ydc-index.io/v1/extract`, `X-API-Key: <key>`, body `{"url", "full_page":
  {"extraction_formats": ["markdown" | "html"]}}`, answer `{url?, extraction_source?, title?,
  contents?: {full_page?: {markdown?, html?}}, metadata?}`.
- Endpoint choice: this is the Extract API. The Contents API (`/v1/contents`) still works but is
  documented as deprecated and is not used; the migration table maps `formats` to
  `full_page.extraction_formats`, which is what the adapter sends.
- Response mapping: `contents.full_page.markdown` is native Markdown, `contents.full_page.html` is the
  page HTML, and the adapter asks for exactly one of them per request. `title` is captured; an empty
  `contents` object means nothing was extracted and is reported as `unsupported-content`. No target
  status is in the contract.
- Cost: the billing page publishes $0.90 per 1,000 URLs, plus $0.50 per 1,000 PDF pages when
  `parse_effort` stays at its `standard` default. (The batch brief assumed this price was unpublished;
  the billing page does publish it, so the documented number is recorded instead of "unknown".)
- Errors: `401` key, `402` depleted prepaid balance, `403` key scope, `422` invalid URL or request,
  `502` "the page itself can't be extracted" (`site_blocked`, `site_unreachable`,
  `unsupported_content`), `5xx` retryable service errors. A `502` is an API status, never a target
  status.

## Keenable

- Contract: [Fetch reference](https://docs.keenable.ai/api-reference/fetch.md) — `GET
  https://api.keenable.ai/v1/fetch` with query parameters (`url` required; `max_chars`, `live`,
  `prompt`, `session_id` optional) and `X-API-Key`; the public path `GET
  https://api.keenable.ai/v1/fetch/public` takes the same parameters with no key and requires
  `X-Keenable-Title`. Answer: `{url, content (required), truncated?, total_chars?, title?, author?,
  published_at?, description (deprecated), usage?}`.
- Method: this is the one documented GET-with-query operation in the batch. The shared REST transport
  gained an explicit GET form for it — the adapter never posts a body to a GET endpoint.
- Response mapping: `content` is native Markdown (the provider caps it at `max_chars` and says so with
  `truncated`), `title` is captured when present, and `url` is the final address after redirects, so
  it becomes the final URL. `author` and `published_at` are documented but the page-fetch result
  contract has no field for them, so they are not surfaced; the provider note says they exist. A
  `truncated: true` answer is recorded as truncated by the provider, which is different from the
  engine's own output truncation.
- No target status: a `404` means "there is no page at this URL" as the API's answer, and a `422`
  means the page exists but could not be extracted. Neither is turned into a target `statusCode`.
- Cost: keyless public access is limited to 1,000 requests/hour and 10/second per IP and endpoint at
  no charge (the live answer confirmed `x-ratelimit-limit: 1000`); a key gets 100,000 fetches/month
  free, and a fetch the provider had to crawl live is billed under the separate `fetch.live` SKU.
  Settings-level text tells the user to confirm current account terms rather than assume the free
  allowance continues.
- Errors: `400` invalid parameter, `401` missing/invalid key, `402` out of credits, `403` revoked key,
  blocked target or private address, `404` no page, `422` unextractable page, `429` rate limit, `5xx`
  server side.

## AnySearch

- Contract: [/v1/extract reference](https://www.anysearch.com/docs/api-endpoints/v1-extract.md) —
  `POST https://api.anysearch.com/v1/extract`, `Authorization: Bearer <key>` for the keyed path, body
  `{"url": "<target>"}`, answer `{code, message, request_id, data: {url, title, content}}`. The body
  accepts no format, cookie, header or rendering parameter.
- Anonymous access: the reference documents anonymous requests metered per IP, a daily free reset,
  `429` for an anonymous IP rate limit, and a `402` that may carry generated credentials in its
  message once the anonymous quota is gone. The live probe confirms anonymous extraction returns the
  documented document.
- Response mapping: `data.content` is cleaned page text, and the operation documents no format choice,
  so it is labelled text (`response-text`) and never presented as native Markdown or as page HTML.
  `data.title` is captured; `code` other than 0 is an application-level failure.
- Credential handling: the `402` body can contain a username, password and API key. The shared REST
  transport never reads a non-2xx body, so nothing from that document can reach a note, a message or a
  diagnostic.
- Cost: anonymous requests are free within the per-IP quota; the keyed free plan is 1,000/day at
  10 QPS, and Pro calls are billed separately.
- Errors: `400` invalid URL/body, `401` invalid credentials (which do **not** fall back to anonymous),
  `402` quota exhausted, `403` expired key or forbidden, `422` `extract_failed`, `429` rate limit.

## Doubao (Volcengine)

- Contract: [网页解析 Fetch reference](https://docs.volcengine.com/docs/zh/networked-search/doubao-search-web-analysis-fetch.md)
  — `POST https://open.feedcoopapi.com/search_api/fetch`, `Authorization: Bearer <API key>`, body
  `{"Url": "<target>"}`, answer `{ResponseMetadata: {RequestId, …, Error?: {CodeN, Code, Message}},
  Result: null | {Data: {StatusCode, Url, RedirectedUrl?, Title?, PublishTime?, ContentText?},
  LogId}}`.
- Separation that matters: `Result.Data.StatusCode` is the **target page's** status and
  `ResponseMetadata.Error` is the **API's** own failure (`Result` is `null` in that case). The adapter
  reads `Error` first, names its stable numeric/string code in a bounded note, and never turns an API
  error into a target status. On a target failure (`StatusCode` 400 or above) the outcome is a target
  HTTP failure with `statusCode` set while `apiStatus` stays 200.
- Response mapping: `ContentText` is plain text, capped by the provider at 50,000 characters, and is
  labelled text (`response-text`); it is never relabelled as Markdown or HTML. `Title` is captured,
  `RedirectedUrl` (when present) becomes the final URL, and `PublishTime` is documented but has no
  field in the fetch result contract. Only the page's static HTML is parsed — no JavaScript.
- **Hard caveat, stated everywhere the mode appears:** Fetch is supported by **pay-as-you-go API keys
  only**. A subscription-plan key works for search and fails for fetch with error code `10409`
  ("套餐模式不支持 Fetch"). This plugin cannot tell the two key types apart before the call, so the
  provider note, the mode's cost metadata, the readiness card and this document all say so plainly.
- Cost: each fetch draws 1 call from the 500/month free allowance shared with Doubao search, and after
  that is billed at ¥0.003 per call (usage-based, post-paid). Subscription packages cannot be used for
  fetch and their allowance is not consumed by it.
- Errors: `10400` parameter, `10403` permission, `10406` free allowance exhausted, `10407` no free
  allowance policy, `10408` fetch unavailable, `10409` subscription key, `10410` no fetch package,
  `10413` target refused by robots/content policy, `10412` package quota, `10500` internal, `10502`
  crawl failed, `700429` rate limit.

## open-websearch (self-hosted)

- Contract: the project's [local daemon HTTP API](https://raw.githubusercontent.com/Aas-ee/open-webSearch/main/docs/http-api.md)
  — `POST http://127.0.0.1:3210/fetch-web` with `{"url", "maxChars" (1000-200000, default 30000),
  "renderMode": "request" | "auto" | "browser", "readability"?, "includeLinks"?}` and the daemon
  envelope `{status, data, error, hint}`; on success `data` carries `{url, finalUrl, contentType,
  title, retrievalMethod, truncated, content}`.
- Response mapping: `data.content` is extracted page text, labelled text (`response-text`);
  `data.finalUrl` (or `data.url`) is the final URL; `data.title` may be empty, in which case the title
  is unavailable rather than an empty string. A `status` other than `ok` is a provider failure whose
  envelope `error.code` is named in a bounded note. No target status exists in the contract.
- Method: the port is the daemon's own documented default (`3210`); the endpoint is the daemon's
  address from its configuration, so the mode is unreachable unless that daemon is running.
- Cost: no vendor fee and no published quota; the daemon's own rate limits and the operator's
  infrastructure costs apply.
- Evidence: the daemon did not answer during this run, so the mode is documented-only. Its request
  shape is covered by fixtures, not by a live call.

## Error mapping shared by every keyed mode

`401` → `authentication`; `402` → the quota/balance kind; `429` → the rate-limit kind; any other
non-2xx → the HTTP kind. The provider API status is preserved on the attempt as `apiStatus`, separate
from the target status (`statusCode`). The provider's error body is never read into a message, a note
or a diagnostic, and the stored key never appears in any user-visible string. None of the transports
follows a redirect, and a response over the byte bound is a fatal acquisition limit rather than a
partial page.

A target status a provider reports is classified the same way whichever transport reported it: 400 or
above is the *target's* HTTP failure (outcome `http-error`, failure kind `http`, `statusCode` set), and
anything else is a provider-side failure. One `error:http` fallback rule therefore behaves identically
across all providers.

A missing key is an ordinary `authentication` attempt, not a fatal error: the engine and the provider
transport both refuse to build the request, and the attempt carries a note saying the credential is
missing instead of a request being sent. Because the outcome is non-fatal, the route's fallback rules
decide what happens next. The saved configuration stays valid: an unconfigured key is allowed at save
time and is reported as a readiness problem in the settings page.

An **anonymous** mode is the opposite case: it sends no credential, is never refused for lacking one,
and the engine never resolves a credential for it. Tavily's keyless mode sends its documented marker
header instead; Keenable's public path sends its application title header instead; AnySearch and
open-websearch send neither.

## The credential is the search credential

Fetching reuses `backendCredentialRef(providerId)` — the same fixed reference the provider's search
mode uses (`DSH_SEARCH_<ID>_KEY`). There is no second key, no fetch-only credential and no second
input box: the one credential control is rendered on the provider's search card whenever any operation
needs the key, and the fetch card shows configured/not-configured and links directly to that input. A
keyed fetch therefore works while the provider's search mode stays keyless, without the page claiming
that no credential is needed. Switching a provider between keyless and keyed fetching never asks the
user to enter the same secret twice.

## What is not verified

- **No live keyed call was made, for any provider.** Nine keyed modes are implemented from official
  documentation; their request shapes, field names and error semantics are contract-tested against
  fixtures built from that documentation, not from a real response. Nothing here proves any endpoint
  accepts this exact request today.
- The documented `401`/`402`/`429` envelopes were not observed on any keyed endpoint; only their
  classification is implemented (from the shared transport's status mapping).
- **DeepSeek**: not verified that a live fetch returns exactly `{title, content}`; the guide's example
  is the only source. The interaction between the account-level 25 QPS and the per-domain limit was
  not observed.
- **Serpex**: not verified that `format: html` returns a full document for real pages, nor how much of
  a JavaScript-heavy page it renders. `results[].status_code` on a *successful* extraction is
  documented in the example only; the adapter reads it when present and leaves the target status
  unavailable when it is absent.
- **Linkup**: the reference marks `includeRawHtml` deprecated and points at `includeRawContent` +
  `contentType`, while the overview still documents `includeRawHtml`. The adapter follows the
  reference (the non-deprecated field) and gates HTML on `contentType`; it is not verified that a live
  answer returns `contentType: "html"` (or any `contentType`) for an HTML page. If it does not, an
  HTML request is reported as `unsupported-content` rather than mislabelled — that path is the honest
  failure, not a silent success.
- **Tavily**: the `results[].title` field seen in the live keyless answer is not in the published
  schema; it may be undocumented, transient or a schema gap. The adapter reads it only when it is a
  non-empty string.
- **You.com**: not verified that `extraction_formats: ["html"]` returns HTML for every page type, nor
  how a PDF is answered (the contract says PDFs are supported, with `full_page.html` describing an
  HTML rendering). The `$0.90/1,000 URLs` price and the PDF page surcharge are quoted, not measured.
- **Keenable**: the keyed path was not called; `usage` and `fetch.live` billing were not observed. The
  documentation's note that earlier API versions sent `published_at` as Unix seconds is irrelevant to
  this adapter, which does not read that field.
- **AnySearch**: the anonymous quota's actual size was not measured (only the rate-limit headers of
  one call were seen). The `402` body that can carry generated credentials was never triggered, and
  is structurally out of reach because non-2xx bodies are never read.
- **Doubao**: whether a pay-as-you-go key really fetches, and whether a subscription key really fails
  with `10409`, was not observed — no key exists here. The key-type caveat is therefore a documented
  warning, not a detected condition. `PublishTime` and `ResponseMetadata` fields beyond `Error` are
  not read.
- **open-websearch**: no daemon answered, so the mode was not exercised at all; its endpoint default
  (`3210`) and request shape come from the project's documentation. Whether the daemon returns HTML
  for HTML pages is not established, which is why HTML is not declared for this provider.
- Latency, real extraction quality and JavaScript-heavy page behaviour are unknown for every provider
  here.
- Billing was not exercised anywhere: every price in this document is quoted from the provider's own
  pricing documentation, never measured.

## Rejected candidates and left-out options

- `you` **anonymous fetch**: the keyless MCP server answered an anonymous client with an
  authentication error (recorded in the first batch), so no keyless You.com fetch mode was added. Its
  search behaviour is unchanged.
- `tavily` **MCP fetch tool**: the keyless documentation lists a remote MCP server with a
  `tavily-extract` tool, but this batch's contract is the REST endpoint and the MCP client does not
  support per-server custom headers, which the keyless path requires. Only the REST operation is
  implemented; adding the MCP variant would need a transport change that this batch does not make.
- **Doubao `ResponseMetadata` version/region fields**, **Keenable `prompt`/`session_id`**, **Tavily
  `query`/`chunks_per_source`/`include_images`/`timeout`**, **Linkup `schema`/`instructions`**, and
  **You.com `extraction_source`/`parse_effort`** were left out: each changes what the response means
  or what it costs, and none is needed to return the page. A caller cannot reach them, so a fetch
  stays one documented page-in, page-out operation.

## Consequences recorded in the design

- Three providers can serve page HTML (Serpex, Linkup, You.com); the rest are Markdown or plain text
  and an HTML request is an `unsupported-format` skip with **no request sent**. No provider's text is
  wrapped as HTML.
- `format: html` is therefore no longer HTTP/browser-only, but it is still a capability decision made
  before any request: the engine asks the catalog, not the adapter.
- The transport is declared per mode and never guessed from an endpoint shape. A mode with no adapter
  for its transport is refused instead of being rerouted.
- Cost lives on the mode: keyless and keyed fetching on the same provider are separate prices, and the
  settings page shows the selected mode's price before the mode is enabled.
- Only the target URL is sent to a provider. Browser cookies, rendered HTML and local session state
  are never forwarded.
