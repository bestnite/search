# @nite07/search-core

A provider-agnostic multi-backend web search engine in TypeScript. It ships the backend catalog,
the per-backend adapters, the HTTP transport and a single `SearchEngine`, with no dependency on any
host framework — the DeepSeek Harness plugin and the MCP server are both thin shells over this.

## What it guarantees

- **Explicit access mode per backend.** A backend is used in exactly the mode the caller selected:
  anonymous, key, OAuth or a session cookie. There is no fallback between modes, keys or endpoints.
- **Bounded retries.** Only the configured HTTP statuses are retried, `Retry-After` is honoured, and
  a retry never changes the provider, the mode or the credential.
- **Honest failures.** A partial failure returns what worked and names what failed; a total failure
  says the search failed instead of returning an empty result. Failures are never cached.
- **Cost visibility.** Every access mode carries a cost tier and a dated quota note, so a caller can
  show a user the price before enabling anything.

## Install

```sh
npm install @nite07/search-core
```

## Use

```ts
import { SearchEngine, catalog, defaultConfig } from '@nite07/search-core';

const config = defaultConfig();
config.backends.exa!.enabled = true;          // anonymous mode works without a credential
config.backends.keenable!.enabled = true;

const engine = new SearchEngine(
  config,
  async reference => process.env[reference],  // resolve credentials however your host stores them
);

const result = await engine.search({ query: 'cordis plugin loader', maxResults: 8 });
console.log(result.sources);   // citeable sources
console.log(result.content);   // failure report, when anything failed
```

`search(input, signal?, onlyBackend?, overrides?)` accepts per-call strategy overrides —
`mode`, `backends`, `exclude`, `backend`, `compact`, `maxResults` — without touching the saved
configuration.

## Backends

23 entries across four access modes: anonymous tiers, free allowances, trial credits, paid APIs, and
two session-cookie backends (X, Reddit) that use the account you already have. `catalog` carries the
mode list, cost tier, quota note and options for each one. Reddit threads are available through
`fetchRedditThread`, X searches through `searchX`, and X conversations through `fetchXThread`.

X is read the way the site itself reads it: the operations the web app embeds in a page (search and
per-post conversation) are mined from that document, then called directly with the cookies. No
transaction-id signing, no bundle crawling, and a stale operation id is rediscovered once.

## Development

```sh
npm install
npm run check     # typecheck, tests, build
```

## License

MIT.
