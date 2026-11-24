# Browser session internals

What `BrowserSession` guarantees, for people changing `packages/core/src/browser.ts` or debugging a
stuck browser read. Users do not need this page; setup lives in the [core README](../packages/core/README.md)
and [image README](../packages/core/image/README.md).

## One session per site identity

`sessionFor(key, options)` keeps one session per process, keyed by endpoint, token, site URL, state
file, the concurrency cap and the retained-tab pool size. Both limits are part of the key deliberately:
a reader that omitted one would silently join a differently bounded session, so a note or comment read
must pass the same values a search uses.

A session owns its own connection, context and page. It never touches the keeper's context — that
belongs to a different client and holds the human sign-in window.

## Transactions and the admission limiter

A transaction is the health probe, the page script and the result mapping for one read. Search, note
and comment reads share one per-site limiter, so up to `maxConcurrentReads` transactions run at once
and the rest wait in FIFO order.

Configuration is `browser.maxConcurrentReads` (integer 1–8, default 2). The default is a deliberately
conservative local starting point, not a site quota. An out-of-range or non-integer value is a
configuration error, never a silent clamp. A saved configuration from before the field existed is
filled with the default on load.

Because transactions on separate tabs interleave, each result is bound to its own async call; there
is no shared mutable result state.

## Retained search tabs

A successful search may retain its tab so a follow-up read can click the card that produced a result.
Configuration is `browser.maxPooledTabs` (integer 1–8, default 4), independent of
`browser.maxConcurrentReads`: the pool bounds idle pages kept for reuse, while the admission limit
bounds transactions currently running. Beyond the configured pool size, the least recently used tab
is closed. Pooled tabs are also closed when the session idles out or its generation is recycled, and
an older saved configuration gains the default pool size on load.

## Generations and recycling

The page belongs to a generation with an in-flight reference count.

- Initialisation is single-flight: concurrent first reads share one `connect`/`newContext`/`newPage`.
- An identity probe reporting a guest fails as an authentication problem before any business script
  runs.
- A lost sign-in (login text, HTTP 401 or 406), a lost connection or a closed tab marks the generation
  **stale**. New reads stop joining it, its in-flight reads finish, then it is disposed and the next
  generation opens.
- A closed tab rebuilds only the page. An expired sign-in or a lost connection reloads the state file.
- The failed read is not replayed. A 403 from a private note does not invalidate the page, because the
  refusal belongs to the subject rather than to the session.
- A 429 is returned as `rate-limit` and not retried. That session then admits one read at a time until
  the session is replaced. This is a local slowdown, not a claimed official quota or cooldown.

## State file policy

`statePolicy: 'read-only'` (what the Xiaohongshu reader uses) loads the session file into every new
context and never writes it back, because the keeper inside the browser image is its only writer.
`'read-write'` remains the default for callers that own their own file; `persist()` runs as exclusive
maintenance behind in-flight reads and moves its save clock only after a save actually succeeded.

## Shutdown and idle release

- The session releases its connection and context after five idle minutes, and only when no read is
  active and none is queued. The next read reattaches.
- Idle registry entries are retired rather than accumulating, so a stale reference rejects new reads
  instead of forming a second queue for the same site.
- `close()` and `closeBrowserSessions()` refuse new reads, cancel queued ones, wait a single total
  five-second budget (including teardown) for in-flight reads, then drop the connection. A repeated or
  concurrent call is a no-op.
- A browser call already in flight is not hard-cancelled: forcing the connection closed makes it fail,
  but a callback stuck outside the browser is not force-cancelled — `close()` still returns after its
  bound.

## Save-time endpoint verification

The settings save path does not use `BrowserSession`, and must not: a save cannot disturb the page a
site reader or the VNC keeper owns. `verifyBrowserDependencies(config)` in
`packages/core/src/browser-verification.ts` opens its own client instead:

- It collects every **enabled** browser dependency: search backends whose saved mode is `browser`, and
  the page-fetch `browser` route. It uses the same effective-endpoint rules as the readers — the shared
  endpoint wins and a search backend's own endpoint is only the fallback; the fetch browser route uses
  the shared endpoint only.
- Identical endpoint/token pairs are grouped, so two dependents on one browser cause one connection.
- For each group it attaches, creates one isolated context, closes that context, then disconnects.
  `close()` on a connected browser releases this connection and the contexts it created; the browser
  server and other clients stay alive. It never navigates or sends a site or business request.
- The bound is one total deadline for the whole save (about five seconds), covering the token read,
  the connection, context creation and bounded cleanup. A resource that arrives after the deadline is
  closed on arrival. A timeout is a refusal, never a pass.
- The request signal and the plugin lifetime cancel the check; cancellation is a refusal, and a late
  connection is still cleaned up.
- Failures are classified into stable codes: `browser.endpoint.missing`, `browser.endpoint.invalid`,
  `browser.authRejected`, `browser.unreachable`, `browser.protocolMismatch`, `browser.timeout` and
  `browser.contextFailed`. A failure produces one actionable issue per dependent switch.
- No enablement means no network access at all, so browser settings can be saved offline while every
  dependent is off.
- A successful check only proves the endpoint and token work. It does not prove any site login.

## API notes

`BrowserSession.read(callback, signal?)` is the transaction entry point; its callback receives only
`evaluate` and `invalidate`, so a read cannot close or persist the session. `evaluate`, `target` and
`persist` remain as compatibility entry points and share the same limiter. Reads no longer call
`bringToFront`, so attaching cannot pull focus away from the VNC sign-in window.

`DEFAULT_MAX_CONCURRENT_READS`, `MIN_MAX_CONCURRENT_READS` and `MAX_CONCURRENT_READS` are exported
from the browser-safe entry point, so a settings UI can render the control without importing the
browser driver.
