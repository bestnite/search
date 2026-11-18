# @nite07/search-core

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/@nite07/search-core?label=npm&style=flat-square&color=cb3837)](https://www.npmjs.com/package/@nite07/search-core)
[![downloads](https://img.shields.io/npm/dm/@nite07/search-core?label=downloads&style=flat-square&color=cb3837)](https://www.npmjs.com/package/@nite07/search-core)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square)](package.json)

A provider-agnostic multi-backend web search engine in TypeScript. It ships the backend catalog, the
per-backend adapters, the HTTP transport and a single `SearchEngine`, with no dependency on any host
framework — the [DeepSeek Harness plugin](../dsh-search/README.md) and the [MCP server](../websearch-mcp/README.md)
are both thin shells over this.

## Install

```sh
npm install @nite07/search-core
```

## Quick start

```ts
import { SearchEngine, defaultConfig } from '@nite07/search-core';

const config = defaultConfig();
config.backends.exa!.enabled = true;       // anonymous mode: no credential needed
config.backends.keenable!.enabled = true;

const engine = new SearchEngine(
  config,
  async reference => process.env[reference],  // resolve credentials however your host stores them
);

const result = await engine.search({ query: 'cordis plugin loader', maxResults: 8 });
console.log(result.sources);   // citeable sources: url, title, snippet, publishedAt
console.log(result.content);   // human-readable report, including any failure
```

Every backend starts disabled, so the two lines above are what turns them on.

## Choosing backends

`catalog` lists all 24 entries with each backend's access modes, cost tier, quota note and options.
Most have a free or keyless path; a few need a key, OAuth, a session cookie, or a browser you host.

```ts
import { catalog } from '@nite07/search-core';

for (const backend of catalog) {
  console.log(backend.id, backend.modes.map(mode => `${mode.mode}:${mode.tier}`).join(' '));
}
```

Enable one in the mode you want, then set its options if it has any:

```ts
config.backends.searxng!.enabled = true;      // self-hosted, no credential
config.backends.searxng!.mode = 'anonymous';
config.backends.searxng!.endpoint = 'http://127.0.0.1:8385/search';
```

The full per-backend quota and price table: [BACKENDS.md](../dsh-search/docs/BACKENDS.md).

## Credentials

Credential names are fixed in code, not configuration fields, and both helpers are exported for hosts
that store secrets:

- `backendCredentialRef(id)` — `DSH_SEARCH_<BACKEND_ID>_KEY`, with hyphens replaced by underscores and
  the id uppercased.
- `browserCredentialRef()` — `DSH_SEARCH_BROWSER_TOKEN`, the single token every browser-backed reader
  uses.

Anonymous modes never resolve a credential, and `parseConfig` drops saved `credentialRef` fields rather
than letting a file redirect a lookup.

## Configuration issues

`validateConfig(value)` returns `ConfigIssue[]`. `path` and `message` are always populated, so a host
that knows nothing about the newer fields still gets a readable English sentence per issue. The stable
layer is optional:

```ts
interface ConfigIssue {
  path: string;                    // dotted configuration path
  message: string;                 // English fallback, complete on its own
  code?: string;                   // stable cause, e.g. 'field.range' or 'browser.authRejected'
  params?: Record<string, string | number>; // values for the localized sentence
  action?: { target?: string };    // path/section to reveal when the value path is not enough
}
```

Rules inside a route are validated by `validateRuleIssues(rules, routeKind, path)` and report deep
paths such as `pageFetch.routes.0.rules.0.conditions.0.value`; `validateRules` remains the string-only
compatibility wrapper. Route issues carry `params.kind`, so a settings page can name the route after it
is reordered instead of showing an array index.

## Save-time browser verification

`verifyBrowserDependencies(config, options)` is the authoritative check a host runs before writing a
configuration that enables browser-dependent features. It takes an optional `resolveToken`, an
injectable `connect` transport (tests use this; production defaults to `chromium.connect`) and a
`timeoutMs` total budget and an optional `signal`. Cancellation rejects with `BrowserVerificationAborted`
and is never treated as a pass. `verifyBrowserEndpoint(endpoint, options)` runs the same bounded probe
for one manual check. See [BROWSER-SESSIONS.md](../../docs/BROWSER-SESSIONS.md#save-time-endpoint-verification)
for the protocol and cleanup guarantees.

## Results and failures

`search()` always resolves with a report; it does not throw for a backend that failed:

```ts
const result = await engine.search({ query: 'x', maxResults: 8 });
result.sources;   // the sources that worked, after dedup and fusion
result.content;   // a readable report naming every failed backend and why
result.outcomes;  // per-backend detail: ok, error kind, duration, attempts
```

A partial failure keeps what worked. A total failure says the search failed instead of returning an
empty list, and failures are never cached.

`search(input, signal?, onlyBackend?, overrides?)` accepts per-call strategy overrides — `backends`,
`exclude`, `compact`, `maxResults` — without touching the saved configuration. How many backends run is
decided by the call: one id in `backends` runs that backend alone, several run in parallel, and a call
that names none runs every enabled backend. `onlyBackend` is the internal single-backend probe the
settings page and `search_manage` use.

## MCP-backed backends

`exa`, `parallel` and `you` have an anonymous mode that is a remote MCP endpoint. That protocol is
served by [`@modelcontextprotocol/client`](https://ts.sdk.modelcontextprotocol.io/v2/): it negotiates
the revision, replays `Mcp-Session-Id`, and parses both JSON and SSE answers. What stays in this
package is what belongs to it — which tool to call, a pre-flight check of the parameters against the
tool's schema, and the failure wording a search panel can show.

## Modes of access

A backend is used in exactly the mode you selected: `anonymous`, `key`, `oauth`, `session` or
`browser`. There is no fallback between modes, keys or endpoints, and retries stay on the same provider
and mode. Only the configured HTTP statuses are retried, `Retry-After` is honoured, and a retry never
changes the provider.

## Browser-backed backends

Sites that answer only their own page runtime (currently Xiaohongshu) read through a browser you host.
Run the container from [`image/`](./image/README.md), sign in once over VNC, then:

```ts
config.browser.endpoint = 'ws://127.0.0.1:3000/ws';
config.browser.statePath = '/path/to/search-browser/data/state.json';
config.browser.maxConcurrentReads = 3;   // optional per-site cap; default 2, range 1–8
config.backends.xiaohongshu!.enabled = true;
config.backends.xiaohongshu!.mode = 'browser';
```

The endpoint token is resolved from `DSH_SEARCH_BROWSER_TOKEN`. A missing token does not block
attachment to an endpoint that accepts unauthenticated clients. The library only attaches and only
reads: signing in and keeping the profile stay with whoever owns that browser.

`maxConcurrentReads` bounds how many reads run on one site at once. It is a local safety bound, not a
site quota; an out-of-range value is a configuration error rather than a silent clamp.

Direct readers are exported for hosts that want one call without the engine: `searchXhs`,
`fetchXhsNote`, `fetchXhsComments`, `searchX`, `fetchXThread` and `fetchRedditThread`.

How sessions, generations and recycling work internally: [docs/BROWSER-SESSIONS.md](../../docs/BROWSER-SESSIONS.md).

## Page fetching

Search answers "which pages exist"; page fetching returns one page that already exists. The two share
configuration and credentials but nothing else: a fetch has its own routes, rules and limits.

```ts
import { PageFetchEngine, defaultConfig } from '@nite07/search-core';

const config = defaultConfig();
const engine = new PageFetchEngine(config, {
  resolveCredential: async reference => process.env[reference], // same fixed names as search
});

const page = await engine.fetchPage({ url: 'https://example.com/article', format: 'markdown' }, signal);
if (page.ok) console.log(page.content);
console.log(page.stopReason, page.attempts);
```

`format` is required: `markdown` to read, `html` to inspect structure. There is no saved default and no
implicit conversion from one to the other.

Routes run one at a time in the saved order — HTTP, the shared browser, and one selected provider by
default — and each route evaluates its own fallback rules. Rules are OR, conditions inside one rule are
AND, and a condition is true, false or unavailable; a missing title or status is never treated as an
empty string. A matched rule continues to the next route, no match stops. Cancellation, the overall
deadline, a refused target, invalid global configuration and acquisition limits are fatal and never
fall back.

Results are bounded and JSON-safe: `content`, `contentRoute`, `contentProvider`, `representation`,
`statusCode` (target only), `ok`, `stopReason`, `truncated`, and one `attempts[]` entry per executed
route with its duration, outcome, target status, provider API status, matched rule ids, unavailable
inputs and a sanitized error. A successful result requires usable content, a successful target response
when one is known, and no matched rejection rule.

Safety defaults are public-only targets. The HTTP transport resolves each name inside the socket
lookup, applies the address policy to every answer and connects to the address it validated, so a
rebinding window between check and connect does not exist. Redirects are followed manually, one bounded
hop at a time, and re-checked. A browser or provider route resolves the target elsewhere, so the local
address policy cannot prove its destination: enabling such a route is that decision, there is no second
switch to keep in step with it, and every result such a route produces carries the trust-boundary note.
Literal private and local targets are still refused before a route runs.

Fetch adapters are catalog metadata, not user toggles: this release ships Exa and Parallel, each with
a keyless MCP mode (`web_fetch_exa` / `web_fetch`) and a keyed REST mode (`POST /contents`,
`POST /v1/extract`). The transport is declared per access mode, so the provider route is still one
route: `mcp` calls the tool, `rest` posts to the mode's documented endpoint. All four modes return
native Markdown; asking a Markdown-only provider for HTML skips it without a request and continues to
the next enabled route. The keyless modes were observed live; the keyed modes are implemented from
the providers' official API references and are recorded as documented-only evidence, since no paid
keyed call was made. A keyed fetch resolves the same fixed credential reference as the provider's
search mode, and a missing key is a configuration failure before any request. See
[docs/PAGE-FETCH-PROVIDERS.md](../../docs/PAGE-FETCH-PROVIDERS.md) for the evidence and the list of
what was not verified.

## Field mapping

Which response key each adapter reads, verified against the vendor docs, is recorded in
[docs/FIELD-MAPPING.md](docs/FIELD-MAPPING.md) along with the gaps that are not bugs.

## License

MIT.
