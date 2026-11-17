# Verification status

Date: 2026-11-17 (Asia/Shanghai), profile `web`. The DSH release running at that moment is recorded once here as audit context; it is not a compatibility bound.

## Automated

`npm run check` (typecheck + 19 tests + build) passes. Coverage highlights:

- Config validation: unknown fields, ranges, enumerations, endpoint schemes (`http(s)` or `ws(s)`, no credentials, query or fragment), unverified backends cannot be enabled.
- Fixed access modes: anonymous mode never resolves or transmits a stored key; key mode without a credential fails without any request; no fallback path exists in the engine.
- Browser token scope: the endpoint token belongs to the shared browser block, so the page stores and reports it once and a browser backend carries no reference of its own; a backend-level reference is only the legacy fallback, and a stored token is never echoed back.
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

Keyed backends (Tavily, Brave, DeepSeek, Zhihu, Baidu, Doubao, Linkup, Serper, Serpex, OpenAI, Anthropic, Mojeek, Tencent) are request/response-tested against documented contracts only. No credential was supplied, so no live keyed call, billing check, or account-quota observation exists. Serper remains unverified and disable-able.

## Deployed state

- Bundle `@nite07/dsh-search` installed by Plugin Manager from the linked worktree; Host fiber active; Settings entry `nite-search` active in the live slot tree.
- `searchProvider: nite-search`, `fetchProvider: http`.
- Old bundle `@240xu/dsh-websearch` disabled, not removed (rollback: enable it and restore `searchProvider: unified`).
- Enabled backends: Keenable, Exa, You.com (anonymous) and local SearXNG. Everything else disabled.

## Not verified

- Rendered Settings page visuals, light/dark parity, keyboard flow and error-summary focus in the live page. The automation browser could not authenticate to `https://dsh.nite07.com/` (`ERR_INVALID_AUTH_CREDENTIALS`), and `/connect?token=…` returned 401 from this shell. The route itself answers 401 rather than 404 unauthenticated, and the slot occupant is registered, but no screenshot or manual pass exists.
- Save-through-UI round trip (the same Host operation is covered by tests and by the tool path).
- MCP anonymous quota behaviour under sustained load; HTML discovery (DuckDuckGo) layout changes; supplier-internal routing.

## UX pass (2026-11-17, same day)

Applied P0+P1 fixes: conditional field visibility (single-backend selector only in single mode; retry/breaker/cache/diagnostics dependants follow their switch; anonymous mode hides the credential surface; unverified backends are read-only), a pre-flight blocker banner (no backend enabled / single mode pointing at a disabled backend / key mode without a stored credential), structured trial-search results with failure reasons, diagnostics with time, reason and message, backend search/filter/count toolbar, collapsed-card cost chips and credential dot, nested advanced options, sticky save bar, inline confirmations instead of `window.confirm`, range-aware field errors, and a checkbox group for retry statuses.

`npm run check` now covers 31 tests, including `visible()` and `blockersOf()` semantics (hidden values are preserved, not reset). Rebuilt and reloaded via one authorized `dsh-web` restart; `web_search` still answers through `nite-search` afterwards and the settings entry stays registered.

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
