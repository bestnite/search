# Implementation Plan

## Settings IA and save gate (implemented 2026-11-18)

The current settings page and save path, as built:

- **Tabs**: Search behavior, Reliability, Test & diagnostics, Search, Browser, Page fetch. All edit one
  draft; tab switches never save or discard, and search vs fetch values stay in their own records.
- **Provider cards**: search and page fetch use the same card anatomy, chips, credential control and
  body spacing. The fetch provider is a fixed radio choice including **none**, never a dropdown; the
  chosen provider's fetch operation settings live inside its card. The credential is one stored secret
  shown by the same control in both views, so it is never entered twice. Search caps do not bound a
  fetch, and the card says so.
- **Browser tab**: owns the shared endpoint, endpoint token, session file, read timeout, per-site read
  cap, and the list of every enabled search/fetch feature that depends on them. Fetch-only context,
  settle and selector options stay on the Page fetch tab. A manual **Check connection** runs the same
  bounded probe against the draft endpoint and is marked stale when the endpoint or token changes.
- **Issues**: `ConfigIssue` gained optional `code`, `params` and `action.target` alongside the original
  `path` and `message`. The page localizes the exact cause in English and Chinese, names routes by
  kind, switches to the owning tab, unfolds the provider card, rules and conditions, and focuses the
  control. Imported or hand-edited malformed values are reported as deep paths, not raw exceptions.
- **Save states**: validation/browser rejection (400 with structured issues), revision conflict (409),
  cancellation (400 `save-cancelled`), write failure (5xx) and transport-unconfirmed are distinct. The
  revision is re-checked inside the editor's file lock against the effective current entry config
  after schema migration/default filling; the inherited layer is not merged again because a profile
  patch value replaces the whole value. A save that landed while verification was running therefore
  wins and the late save gets a 409. Verification and cleanup are cancellable by the
  request or plugin lifetime, and cancellation stops before the write. A failed read-back is reported
  as an unknown result, never as proof that nothing was written. The draft is preserved for every
  outcome; a rejected request is never reported as a possible success.
- **Authoritative browser gate**: before writing, the host verifies the effective endpoint and stored
  token for every enabled browser dependency. The probe is one bounded attach plus isolated context
  create/close/disconnect per distinct endpoint/token pair, never a navigation or a site request, and
  it never closes the remote browser. Empty, unreachable, rejected, timed-out or protocol-mismatched
  endpoints refuse the save with structured localized issues. With every dependent disabled, the
  configuration saves offline without a probe. `search_manage` can re-check the saved endpoint only;
  the settings page can check its draft. See
  [BROWSER-SESSIONS.md](../../../docs/BROWSER-SESSIONS.md#save-time-endpoint-verification).

## Status and scope

Planning baseline: 2026-11-17. This section is the original plan; the section above records the
settings IA and save gate that have since shipped.

Build an independent DSH bundle replacing the currently installed search plugin after verification. Keep the native `web_search` entry point. Do not modify DSH itself or patch installed third-party code.

Verified environment during planning:

- Audited against the installed DSH release at the time of writing; this plugin is not pinned to it.
- Existing search bundle: `@240xu/dsh-websearch` `2.8.8`, provider ID `unified`.
- Search extension: `ctx.web.registerSearchProvider()`.
- Settings extension: Client `settings.section`.
- Configuration persistence: `configEditor`; secrets: DSH credentials.

Reinspect exact live contracts before implementation. Do not assume historical settings behavior applies to the installed release.

## Binding behavior decisions

### Explicit access modes

- Each backend has its own independent enabled switch.
- Where supported, the user explicitly selects anonymous/keyless or API-key access.
- There is no automatic access mode.
- Selecting anonymous access must never read or transmit a saved key.
- Selecting key access without a usable credential returns a configuration failure.
- Switching modes preserves stored credentials but does not activate them implicitly.
- Disabled backends make no search requests or background health requests.
- Different protocols or products may be separate backend entries when needed; duplicate access paths must not be enabled implicitly.

### No fallback

- Never switch backend, endpoint, access mode, or credential in response to failure.
- Aggregation invokes only the backends explicitly enabled by the user.
- Do not add priority failover, anonymous-to-paid escalation, key rotation, or credential fallback.
- The only permitted automatic recovery is bounded retry of the same operation under the retry policy.

### Retry policy

Proposed conservative defaults, configurable in the Web UI:

- Retry eligible HTTP statuses: `408`, `429`, `500`, `502`, `503`, `504`.
- At most two additional attempts, with exponential backoff and jitter.
- Honor valid `Retry-After` on `429` and `503`, within the overall deadline.
- Other statuses, including authentication and validation errors, are not retried by default.
- Explicit quota exhaustion or insufficient balance is terminal, even when HTTP status is `429`.
- Network errors and request timeouts are not retried by default; expose independent opt-ins.
- User cancellation or overall deadline expiration stops requests and backoff immediately.
- A retry never changes backend, endpoint, selected mode, or credential.
- Document possible repeated charges; use stricter adapter defaults when billing or idempotency semantics require them.
- Expose retry enablement, status allowlist, maximum retries, initial delay, maximum delay, and network/timeout opt-ins.

### Failure reporting

- Return failures in tool-visible content, not only server logs.
- Include backend, access mode, error classification, safe explanation, HTTP status where available, and attempt count.
- Explicitly ask the Agent to inform the user and give a safe next step.
- Partial success returns valid sources plus every failed backend; failure visibility must survive result normalization.
- All-backend failure is a search failure, not a successful search with no results.
- Never expose keys, authorization headers, or sensitive upstream response bodies.
- The plugin can expose instructions to the Agent but cannot guarantee the Agent repeats them.

## Backend inventory

Research the union of the linked forum survey and the installed bundle's backend list. Normalize duplicates, but preserve differences between access protocols and products.

Candidates:

- Keenable
- Zhihu global search and Zhihu site search (independently switchable)
- AnySearch
- Linkup
- Tavily
- Exa (anonymous MCP and authenticated API, where officially supported)
- Baidu Qianfan AI Search
- Volcengine / Doubao Search
- Brave Search
- You.com
- open-websearch
- Serper
- Serpex
- Parallel
- Tencent Cloud WSA
- DeepSeek
- DuckDuckGo
- SearXNG
- Mojeek
- Anthropic
- OpenAI

For every candidate, record official protocol, authentication, endpoint, request/response shape, supported parameters, pricing, free limits, prerequisites, source URL, and verification date. Do not invent undocumented endpoints. Mark unresolved candidates as unverified and disabled; never claim an adapter works without implementation and validation. Report blockers instead of silently dropping candidates.

No account creation, payment enrollment, or multi-account quota circumvention is included.

## Cost classification

Classify access modes, not just platform brands:

1. Free without a published fixed quota: document rate limits and anonymous conditions; do not imply unlimited usage.
2. Recurring free allowance: quantity, unit, reset period, identity/card requirements, and overage behavior.
3. One-time trial: clearly distinguished from recurring free allowance.
4. Paid: unit pricing, official pricing link, and additional model charges where relevant.
5. Unverified: insufficient evidence; disabled by default.

A mode may combine recurring free allowance and paid overage. Self-hosted backends must disclose infrastructure costs separately. Price and quota metadata includes references and verification dates. Do not promise permanent free tiers. Local counters and budgets are estimates, not provider balances unless a real balance API is used.

## Architecture

- Independent Host + Client bundle; no DSH shell changes.
- Typed backend adapter contract with capability metadata and normalized results.
- Single-backend and parallel aggregation modes only; no failover mode.
- Preserve title, URL, snippet, summary, publication time, and backend provenance where supported.
- Deterministic deduplication and result fusion, configurable limits, bounded concurrency and deadlines.
- Unsupported filters must be visible rather than silently represented as applied.
- Cache keys include effective query options and relevant configuration/mode revision. Mode changes cannot reuse incompatible entries.
- HTTP/MCP transports must be implemented from verified contracts, with cancellation and sanitized errors.
- Prefer platform facilities and maintained dependencies; assess license, maintenance, recency, and weight before adoption. No vendoring or patched dependency forks without approval.

## Complete Web configuration

Integrate under Settings > Search, inheriting DSH theme and locale facilities.

Sections:

- Backend list: cost grouping/filtering, individual enablement, explicit access mode, credential status, endpoint, supported options, test action.
- Search defaults: result count, language, region, time range, safe search, include/exclude domains where supported.
- Aggregation: single or parallel mode, concurrency, deduplication and fusion.
- Reliability and cost controls: deadlines, retry policy, local rate limits and local budget caps. Any circuit breaker must report skipped calls explicitly and must not trigger fallback.
- Cache and privacy: enabled, TTL, capacity, diagnostics retention policy.
- Diagnostics: explicit user-triggered backend test and trial search, latency, attempts, actual mode, and sanitized failures.

Every public configuration field must have an editable control, help text, default, validation, and save/read-back coverage. A generic JSON editor is not a substitute. Secrets are managed through credential controls rather than configuration plaintext.

Include unsaved-change feedback, pending/success/failure save states, reset defaults, inline errors, a focusable linked error summary, and sanitized config import/export. Do not overwrite secrets through redacted export values. Support keyboard navigation, narrow screens, and light/dark themes. Visible strings belong in English and Chinese locale resources; source comments, logs, internal errors, and repository documents are English.

Persist ordinary configuration through DSH's config editor, preserving unrelated fields. Handle reload/disposal correctly and report persistence rejection honestly. Do not hand-edit the active profile.

## Implementation phases

1. Repository and plan baseline (this phase): create local repository, register origin, commit planning documents. Do not push or create a remote repository.
2. Protocol research: complete sourced backend/cost/capability matrix and resolve live DSH contracts.
3. Host implementation: schema, credentials integration, transports, adapters, aggregation, retry, cancellation, cache and error reporting.
4. Client implementation: complete settings UI, localization and configuration coverage.
5. Verification: unit/contract/integration tests and actual installed GUI validation.
6. Migration: install verified bundle, explicitly select its search provider, disable but retain the old bundle, preserve the fetch provider, verify native `web_search` and `web_fetch`, and document rollback.

Report phase boundaries. Follow the approved scope without repeatedly requesting approval for already-authorized work. Installation that requires a traffic-serving restart must be identified before performing it; restart requires explicit approval. Push, merge, publish, and worktree removal remain out of scope without explicit approval.

## Acceptance criteria

- All candidates have an evidence-backed status; implemented adapters have request/response contract tests.
- Every backend can be independently enabled/disabled.
- Every supported access mode can be explicitly chosen; no automatic selection or fallback exists.
- Saved keys are not sent in anonymous mode. Missing keys fail in key mode.
- Only allowed failures retry, with bounded attempts, proper deadlines, cancellation and `Retry-After` behavior.
- Quota exhaustion and permanent errors do not enter retry loops.
- Partial and total failures are visible to the Agent, with accurate attempt counts and no secrets.
- Every public config field is editable and survives save/read-back; validation and credential handling are tested.
- Mode/config changes cannot leak incompatible cached results or counters.
- Tests cover aggregation, duplicates, unsupported filters, empty results, malformed responses, limits, cancellation, cache and redaction.
- Real requests are verified where credentials exist; credential-blocked paths are explicitly unverified.
- Final diff, build output and test assertions are reviewed.
- Plugin metadata, icon, locale resources and package exports are complete.
- GUI is verified at `https://dsh.nite07.com/` after the appropriate artifact rebuild and refresh; a replacement server is not evidence.
- Existing search stays intact until migration verification; the old bundle remains available for rollback.
