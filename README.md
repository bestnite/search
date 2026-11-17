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

Credential names are fixed in code, not configuration fields. Credentialed HTTP modes resolve
`backendCredentialRef(id)` (`DSH_SEARCH_<BACKEND_ID>_KEY`, with hyphens replaced by underscores and
the ID uppercased); browser modes resolve only `browserCredentialRef()`
(`DSH_SEARCH_BROWSER_TOKEN`). Both helpers are exported for hosts that store credentials. Anonymous
modes never resolve a credential. `parseConfig` drops saved `credentialRef` fields rather than using
them to redirect a lookup.

`search(input, signal?, onlyBackend?, overrides?)` accepts per-call strategy overrides —
`mode`, `backends`, `exclude`, `backend`, `compact`, `maxResults` — without touching the saved
configuration.

## Backends

24 entries across five access modes: anonymous tiers, free allowances, trial credits, paid APIs, two
session-cookie backends (X, Reddit) that use the account you already have, and one browser backend
(Xiaohongshu) that drives a browser you host. `catalog` carries the mode list, cost tier, quota note
and options for each one. Reddit threads are available through `fetchRedditThread`, X searches
through `searchX`, X conversations through `fetchXThread`, and Xiaohongshu notes through
`fetchXhsNote` and `fetchXhsComments`.

### Xiaohongshu

Xiaohongshu only answers its own page runtime, so this backend drives a browser you host rather than
an HTTP endpoint. Set the endpoint in the shared `browser` block and store the token printed by
the container under `DSH_SEARCH_BROWSER_TOKEN` in the host's credential store. No credential name
is configured on the browser or backend. Signing in happens inside the browser, over VNC:

```ts
config.browser.endpoint = 'ws://127.0.0.1:3000/ws';
config.backends.xiaohongshu!.enabled = true;
config.backends.xiaohongshu!.mode = 'browser';
```

Every backend in `browser` mode uses that shared endpoint when it is set, so one container can
serve several of them. If the shared endpoint is empty, the backend's own `endpoint` is used.
Token lookup always uses `DSH_SEARCH_BROWSER_TOKEN`; there is no per-backend token fallback. A
missing token does not block attachment to a browser endpoint that accepts unauthenticated clients.

The repository ships [`image/`](./image/README.md): a container with Patchright-driven Google
Chrome, a VNC surface to sign in once, a token-protected Playwright endpoint and a profile volume. Login and
profile management stay with whoever owns that browser — this library only attaches, and only reads.

`patchright-core` is a direct dependency: a patched Playwright that closes the CDP leaks detection
systems probe for. Both sides of the connection must share a major.minor, so the browser image pins
the same version; Playwright's protocol refuses a mismatch with `428 Precondition Required`. Reads
available: `searchXhs`, `fetchXhsNote`, `fetchXhsComments`.

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
