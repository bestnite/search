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

`search(input, signal?, onlyBackend?, overrides?)` accepts per-call strategy overrides — `mode`,
`backends`, `exclude`, `backend`, `compact`, `maxResults` — without touching the saved configuration.

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

## Field mapping

Which response key each adapter reads, verified against the vendor docs, is recorded in
[docs/FIELD-MAPPING.md](docs/FIELD-MAPPING.md) along with the gaps that are not bugs.

## License

MIT.
