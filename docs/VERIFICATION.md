# Verification status

Date: 2026-11-17 (Asia/Shanghai). DSH `0.2.2-rc.3`, profile `web`.

## Automated

`npm run check` (typecheck + 28 tests + build) passes. Coverage highlights:

- Config validation: unknown fields, ranges, enumerations, non-loopback `http`, credentials in URLs, unverified backends cannot be enabled.
- Fixed access modes: anonymous mode never resolves or transmits a stored key; key mode without a credential fails without any request; no fallback path exists in the engine.
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

- Bundle `@nite/dsh-search` installed by Plugin Manager from the linked worktree; Host fiber active; Settings entry `nite-search` active in the live slot tree.
- `searchProvider: nite-search`, `fetchProvider: http`.
- Old bundle `@240xu/dsh-websearch` disabled, not removed (rollback: enable it and restore `searchProvider: unified`).
- Enabled backends: Keenable, Exa, You.com (anonymous) and local SearXNG. Everything else disabled.

## Not verified

- Rendered Settings page visuals, light/dark parity, keyboard flow and error-summary focus in the live page. The automation browser could not authenticate to `https://dsh.nite07.com/` (`ERR_INVALID_AUTH_CREDENTIALS`), and `/connect?token=…` returned 401 from this shell. The route itself answers 401 rather than 404 unauthenticated, and the slot occupant is registered, but no screenshot or manual pass exists.
- Save-through-UI round trip (the same Host operation is covered by tests and by the tool path).
- MCP anonymous quota behaviour under sustained load; HTML discovery (DuckDuckGo) layout changes; supplier-internal routing.
