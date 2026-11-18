# Verification status

Date: 2026-11-17 (Asia/Shanghai), profile `web`. The DSH release running at that moment is recorded once here as audit context; it is not a compatibility bound.

## Automated

`npm run check` (typecheck + 21 tests + build) passes. Coverage highlights:

- Config validation: unknown fields, ranges, enumerations, endpoint schemes (`http(s)` or `ws(s)`, no credentials, query or fragment), unverified backends cannot be enabled.
- Fixed access modes: anonymous mode never resolves or transmits a stored key; key mode without a credential fails without any request; no fallback path exists in the engine.
- Fixed credential names: credential destinations are defined in code, never editable configuration. Legacy name fields are discarded on load, and management requests cannot override the destination with a reference. The shared browser exposes one token input without storage-name controls or explanations. Stored secrets are never echoed back.
- Retry: only allowlisted statuses; bounded attempts on the same endpoint; `Retry-After` honoured and never shortened; `401`/quota-exhaustion bodies are not retried and never surface in results.
- Failure reporting: partial failures and total failure appear in returned content with backend, mode, kind and attempt count; failed backends are not cached.
- Deduplication, domain filtering, local budget accounting (durable domain, serialized reservations, fail-closed on storage errors), cancellation.
- Protocol contracts: Zhihu GET casing/timestamp/Bearer, MCP initialize/initialized/tools-list/call with session header and strict RPC-id matching, You.com nested `results.web`, Tencent TC3 signature against an independently computed vector.
- Host surface: native Config defaults equal the shared client defaults; the authenticated route and the Agent tool share one implementation of save/test/credential operations; revision conflicts are rejected; a stored secret never appears in snapshots.
- Form coverage: every public scalar/array field and every backend field has a real control (a generic JSON box is not used as a substitute).

## Live, anonymous (no credentials, no charges)

Executed through the plugin engine and through DSH `web_search` after `searchProvider: nite-search` activation:

| Backend | Mode | Result |
| --- | --- | --- |
| Keenable | anonymous | Success, results returned |
| Exa | anonymous MCP | Success after adapting to the live `web_search_exa` schema (`query` + `objective`) |
| You.com | anonymous MCP | Success |
| SearXNG | self-hosted loopback | Success (returns more than requested; merged results are capped locally) |
| Parallel | anonymous MCP | HTTP 429 on this network; left disabled |

`web_fetch` still resolves through the `http` provider after the switch.

## Verified, not live

Keyed backends (Tavily, Brave, DeepSeek, Zhihu, Baidu, Doubao, Linkup, Serpex, OpenAI, Anthropic, Mojeek, Tencent) are request/response-tested against documented contracts only. No credential was supplied, so no live keyed call, billing check, or account-quota observation exists. Serper was retired from the catalogue on 2026-11-17 ([BACKENDS.md](BACKENDS.md#retired-entries)), so it is no longer a candidate here. X `key` mode has no live call either; its `session` mode was verified live the same day, as recorded in [BACKENDS.md](BACKENDS.md#x-session-search-verification-2026-11-17-live).

## Deployed state

- Bundle `@nite07/dsh-search` installed by Plugin Manager from the linked worktree; Host fiber active; Settings entry `nite-search` active in the live slot tree.
- `searchProvider: nite-search`, `fetchProvider: http`.
- Old bundle `@240xu/dsh-websearch` disabled, not removed (rollback: enable it and restore `searchProvider: unified`).
- Enabled backends, as read from the live profile configuration: Keenable, AnySearch, Exa, Parallel, You.com, SearXNG and Reddit (all anonymous), X (`session`) and Xiaohongshu (`browser`). Everything else disabled. Live results for several of them are recorded below; [BACKENDS.md](BACKENDS.md) carries its own live table for 2026-11-17.

## Not verified

- Rendered Settings page visuals, light/dark parity, keyboard flow and error-summary focus in the live page. The automation browser could not authenticate to `https://dsh.nite07.com/` (`ERR_INVALID_AUTH_CREDENTIALS`), and `/connect?token=…` returned 401 from this shell. The route itself answers 401 rather than 404 unauthenticated, and the slot occupant is registered, but no screenshot or manual pass exists.
- Save-through-UI round trip (the same Host operation is covered by tests and by the tool path).
- MCP anonymous quota behaviour under sustained load; HTML discovery (DuckDuckGo) layout changes; supplier-internal routing.

## UX pass (2026-11-17, same day)

Applied P0+P1 fixes: conditional field visibility (single-backend selector only in single mode; retry/breaker/cache/diagnostics dependants follow their switch; anonymous mode hides the credential surface; unverified backends are read-only), a pre-flight blocker banner (no backend enabled / single mode pointing at a disabled backend / key mode without a stored credential), structured trial-search results with failure reasons, diagnostics with time, reason and message, backend search/filter/count toolbar, collapsed-card cost chips and credential dot, nested advanced options, sticky save bar, inline confirmations instead of `window.confirm`, range-aware field errors, and a checkbox group for retry statuses.

`npm run check` then covered 31 tests, including `visible()` and `blockersOf()` semantics (hidden values are preserved, not reset). Rebuilt and reloaded via one authorized `dsh-web` restart; `web_search` still answers through `nite-search` afterwards and the settings entry stays registered.

That 31 is history: the engine's tests moved into `@nite07/search-core` when the plugin stopped embedding it (commit `25fc123`), which is why this repository now runs 21 and core runs 109.

Still unverified after this pass: the rendered page itself. The automation browser is rejected by the deployment edge (`ERR_INVALID_AUTH_CREDENTIALS`) for both the token URL and `/connect`, so there is no screenshot or manual keyboard pass. Visual, light/dark and focus behaviour rest on code review only.

## Tier correction (2026-11-17, same day)

Exa, AnySearch and Parallel anonymous modes had been filed under "unavailable · unverified API" because their free quotas carry no published number. That conflated cost with evidence. All three, plus Keenable, You.com and the local SearXNG instance, completed three consecutive real searches each in this deployment; Exa's keyless MCP is an official free tier per its own documentation ("No API key is needed to try search and fetch, at a free rate limit"). Cost tier and verification evidence are now separate fields. DuckDuckGo stays documented-only: it answered with a challenge on this network, and no bypass was attempted.

## Language/region and provider visibility (2026-11-17, after restart)

Live check with canonical `language=zh-Hans`, `region=CN` and retry/cache disabled:

| Backend | Outcome | Disclosed |
| --- | --- | --- |
| Keenable | 2 sources | language and region unsupported, not applied upstream |
| SearXNG | 26 sources (capped locally) | language applied as `zh-CN`; region unsupported |
| You.com | 2 sources | both applied in upper-case form |

So an unsupported canonical value is never forwarded as a guess, and a supported one reaches the backend in its own spelling. Saved values are validated against the fixed lists, so a backend-specific spelling can no longer be typed in by hand.

The settings snapshot also reports the provider the web seam currently selects. When it is not this plugin, the page states which provider is in effect and offers a one-click switch; the built-in providers stay registered and are simply never selected while `searchProvider: nite-search` is pinned.

## Reddit (2026-11-17, live)

Anonymous mode was exercised against the real endpoints, with retry and cache disabled:

| Call | Result |
| --- | --- |
| `searchReddit` "claude code vs codex" | 3 posts returned from r/OpenaiCodex, r/ClaudeCode, r/codex with working permalinks |
| `fetchRedditThread` on the first permalink | post title resolved, 13 top-level comments parsed, `truncated: true` at the 4,000-character test budget |

This confirms the anonymous token flow (Android client id + device headers), the persisted-operation hashes for `SearchPosts` and `PostComments`, the `/by_id` metadata call, and the comment tree shaping. The `oauth` mode is contract-tested only: no client id/secret was supplied, so no live OAuth call was made. Assumptions that remain unverified are listed in the port notes: the OAuth Listing field shapes, and whether the anonymous path keeps working if Reddit closes `/by_id` to those tokens.

## Xiaohongshu and the shared browser (2026-11-18, live)

### Deployment

- Container `systemd-search-browser`, image `localhost/search-browser:latest`, unit source `~/pod/search-browser/search-browser.container`, copy in `~/.config/containers/systemd/`.
- Publishes `3030 → 3000` (the Playwright endpoint, path `/ws`) and `6080` (noVNC); volume `~/pod/search-browser/data:/profile`; `BROWSER_WS_TOKEN` is set in the unit, so the proxy takes the token from the environment and never reads the volume's `ws-token` file.
- Live configuration: `browser.endpoint: ws://127.0.0.1:3030/ws`, `browser.timeoutMs: 60000`, `browser.statePath` empty, Xiaohongshu enabled in `browser` mode.
- An empty `statePath` resolves to the core default `~/.config/dsh-search/browser/state.json`, and `~/.config/dsh-search/browser` is a symlink to `~/pod/search-browser/data`, so the core reads the exact `state.json` the container writes. Without that link the default path is a different file and every read starts signed out.
- The stored credential `DSH_SEARCH_BROWSER_TOKEN` was compared against the container's `BROWSER_WS_TOKEN` by hash, not by eye, and matches. It is the same token the container prints.

### Reads

Executed through `@nite07/search-core` directly against that endpoint and session — the same code path the tool runs, without the tool wrapper:

| Call | Result |
| --- | --- |
| `searchXhs` "机械键盘", 3 results | 3 sources in 3.17 s, each with a working `xiaohongshu.com/explore/<id>` link |
| `fetchXhsNote` on the first source | title, author, 934 likes, 8 tags, one picture and the full description, 2.53 s |
| `fetchXhsComments` on the same note, limit 5 | 5 comments with author, likes, reply count and IP location, `hasMore: true`, 2.52 s |

The note read used only the id the search returned, so the in-process note-token cache is what made it work.

One failure was reproduced deliberately: a token that differs from the container's answers `authentication` naming the endpoint ("rejected the token") before any page is opened. That is the same message the earlier stale `ws-token` file produced, which is worth knowing: when `BROWSER_WS_TOKEN` is set, the file in the volume is dead weight, and the token to paste into the settings is the one the container prints.

### Not verified this pass

- A `xiaohongshu_note` call through the DSH tool surface: the backend-enabled check, the credential lookup from the store, the picture download into the scratch directory and the rendered block.
- The **Shared browser** section of the settings page in a real browser; it rests on code review and unit tests.
- Anything on the site beyond these reads. No search result was clicked, nothing was liked, no note-level action was taken.

## Settings consistency and save gate (2026-11-18)

Automated only; no rendered page was inspected. The deployment edge still rejects this session's
automation browser, so visual layout, light/dark parity, real keyboard flow and the actual focus jump
remain for a human pass in the live host.

What the tests now assert (core + dsh-search suites, injected browser transport, no sockets):

- `ConfigIssue` keeps `path`/`message` complete and adds optional `code`, `params` and
  `action.target`; malformed saves (non-object config, null routes, unknown rule fields, out-of-range
  numbers) still produce paths instead of exceptions.
- Route issues carry `params.kind` and keep their indexed path, so a reordered browser route is still
  named "browser". Deep rule/condition paths (for example
  `pageFetch.routes.0.rules.0.conditions.0`) are reported with condition codes.
- The presenter maps provider fetch fields to the Page fetch tab, `browser.*` to the Browser tab,
  fetch-only browser context/settle/selector to the Page fetch tab, and honours an issue's
  `action.target`.
- The save route returns `409 / revision-conflict`, `400 / validation-failed` with structured issues,
  `400 / browser-verification-failed` with structured issues, or `400 / save-cancelled`, and never
  writes on a rejection.
- Revision is re-checked inside the editor callback against the effective current entry after schema
  migration/default filling, never by merging the inherited layer back (patch values replace whole
  values): a partial saved entry and a non-default inherited layer are not false conflicts, and a save
  that completes during another save's verification wins (the late save gets 409, one write remains).
- A save cancelled before it starts or during verification writes nothing; an aborted browser check
  rejects and closes a connection that arrives late.
- The page's save state machine is an executable pure function: 200/read-back match is saved, 200 with
  a different read-back is a conflict, 400 is a definite rejection, 5xx is only classified after a
  read-back, transport failure is saved/unconfirmed, and a failed read-back is `state-unknown` rather
  than a claim that nothing was written.
- A provider fetch field, the fetch-provider radio group and a backend card hidden by the backend
  filter are executable focus-resolver tests: the resolver walks to the closest mounted container,
  unfolds its details, and the page clears the filter before retrying instead of dropping the focus.
- The save gate groups identical endpoint/token checks, uses the shared endpoint before a backend's
  own fallback, never borrows a search fallback for the fetch route, treats auth rejection,
  unreachable, protocol mismatch, timeout and context failure as distinct causes, closes a context
  that arrives after the deadline, bounds token resolution and cleanup inside the total budget, and
  saves offline with no probe when every dependent is disabled.
- The stored token is sent as a bearer header, never returned in a snapshot, issue, check or save
  response. `search_manage` may only re-check the saved endpoint; an unsaved draft endpoint is
  available only through the authenticated settings route. Credential arguments are rejected.

Still unverified: the rendered page, the five-second wall-clock behaviour against a real slow
container, and the live host's revision/edit race. Those need the real GUI and a real browser
container.
