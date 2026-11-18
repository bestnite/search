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
config.browser.maxConcurrentReads = 3; // optional local cap for this site; default 2
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

### Browser session lifetime

Xiaohongshu reads run as transactions on one kept session per site (endpoint, token, site URL,
state file and concurrency setting). The first read attaches, opens its own context and page, loads
the signed-in session from the state file and reuses them from then on. Initialisation is
single-flight even when several reads start together. A read never closes the connection and never
writes the state file: the keeper in the browser image is its only writer, which is why the
Xiaohongshu reader sets `statePolicy: 'read-only'`.

Search, note and comment reads share one per-site admission limiter. Up to `maxConcurrentReads`
transactions may be in flight at once. The default is 2: a deliberately conservative local starting
point, not a Xiaohongshu quota and not verified against the live site. The option accepts integers
from 1 through 8; anything else is a configuration error rather than a silent clamp. It is the
shared `browser.maxConcurrentReads` configuration field, and `DEFAULT_MAX_CONCURRENT_READS`,
`MIN_MAX_CONCURRENT_READS` and `MAX_CONCURRENT_READS` are exported from the browser-safe entry so a
settings UI can render the control without importing the browser driver. Direct callers can pass the
value through `XhsContext.maxConcurrentReads`; it is part of the session identity, so a note or
comment read must pass the same value to join the session a search opened. A configuration saved
before the field existed is filled with the default on load; an explicit invalid value is rejected,
not replaced. A transaction is a health probe plus its page script plus mapping, so the stages of
different transactions can interleave on the shared page while each result stays with its own call.

The page belongs to a generation with an in-flight reference count. An identity probe that reports
a guest fails as an authentication problem before any business script runs. If a read proves the
sign-in is gone (login text, HTTP 401 or 406), or the connection or tab is lost, that generation is marked
stale: new reads do not join it, its in-flight reads finish, then it is disposed and the next
generation opens. A closed tab rebuilds only the page; an expired sign-in or lost connection reloads
the state file. The failed read is not replayed, and a 403 from a private note does not invalidate
the page because the refusal belongs to the subject, not the session. A 429 is returned as
`rate-limit` and not retried; that session then admits one read at a time until the `BrowserSession`
is replaced. This is a conservative local slowdown, not a claimed official quota or cooldown.

`BrowserSession.read(callback, signal?)` is the transaction entry point. Its callback gets only
`evaluate` and `invalidate`, so a read cannot close or persist the session. `evaluate`, `target` and
`persist` remain as compatibility entry points and share the same limiter; `persist` runs as
exclusive maintenance behind in-flight reads, and reads no longer call `bringToFront`, so attaching
cannot pull focus away from the VNC sign-in window. An abort while a page call is in flight is
observed before the next operation: a browser call cannot be interrupted mid-flight, so that call
finishes before the admission slot is released.

The session releases its own connection and context after five idle minutes, and only when no read
is active and none is queued; the next read reattaches. Idle registry entries are retired instead of
accumulating, so a stale reference rejects new reads rather than forming a second queue for the same
site. `BrowserSession.close()` and `closeBrowserSessions()` refuse new reads, cancel queued ones,
wait up to a single total five-second budget (including teardown) for in-flight reads and then drop
the connection; a repeated or concurrent call is a no-op. A browser call that is already in flight is
not hard-cancelled: forcing the connection closed makes it fail, but a transaction callback stuck
outside the browser is not force-cancelled — close still returns after its bound. The generic
default for `statePolicy` stays `read-write` for callers that own their state file, and `persist()`
moves its save clock only after a save actually succeeded.

X is read the way the site itself reads it: the operations the web app embeds in a page (search and
per-post conversation) are mined from that document, then called directly with the cookies. No
transaction-id signing, no bundle crawling, and a stale operation id is rediscovered once.

## Development

```sh
npm install
npm run check     # typecheck, tests, build
```

The live browser integration check is opt-in and is not part of `npm test`. It reads its endpoint,
token and session file from environment variables and never loads the production container
configuration itself:

```sh
BROWSER_WS_ENDPOINT=ws://... BROWSER_TOKEN=... BROWSER_STATE_PATH=/path/state.json \
  node --import tsx --test test/browser-live.integration.ts
```

## License

MIT.
