# Page Fetch: Requirements and Implementation Design

Status: approved direction; implementation specification. Date: 2026-11-18.

### Delivery sequencing update (2026-11-18)

Both host implementations were already written when the user requested staged delivery. Prioritize core and DSH correctness fixes and review, then let the user test DSH before further MCP integration acceptance or rollout. Preserve existing MCP changes for now; do not discard or deploy them without instruction. Shared core MCP transport fixes remain in scope because the fetch provider route depends on them.

The user subsequently authorized merging the repaired, reviewed core and DSH changes into main and building them. This authorization excludes the deferred MCP host changes. Split commits/diffs accordingly and preserve MCP work on the feature branch/worktree. Check whether main moved before integrating; rebase if necessary. The user will restart DSH themselves: do not restart the service, push, publish, remove the worktree, or change the installed profile. Build success alone does not prove that an installed plugin uses the main-checkout artifacts; inspect and report that distinction before claiming a restart will activate the feature.

Deferred request: improve the MCP settings frontend's excessive page length and grouping/navigation with a Gemini frontend subagent. This is recorded only: do not start that delegation or UI redesign yet. The user described the currently used page as long and lacking tab grouping; do not assume uninstalled worktree changes have addressed the live-page complaint. Revisit after the DSH test gate and an explicit request to proceed.

## 1. Objective and ownership

Add bounded, single-URL page fetching to `@nite07/search-core`, with shared integration in the DSH plugin and standalone MCP server. The parent agent owns this specification and integration review. A DeepSeek implementation agent owns implementation, tests, migration, and supporting documentation. No DSH core modifications, profile installation, service restart, publication, push, or merge are authorized.

The human approved sequential configurable routes, content-based fallback rules, HTML/Markdown output chosen by the agent, native provider Markdown, and one shared provider configuration shown through separate search/fetch views. This specification resolves remaining engineering details conservatively; deviations must be reported, not silently invented.

## 2. Scope

Deliver:

- A host-independent core page-fetch API and typed results.
- Three independently enabled, user-ordered routes: HTTP, browser, provider.
- Configurable per-route fallback rules, including status, network errors, timeout, title, HTML, text, and Markdown matching.
- HTML and Markdown outputs; `format` is required on every call.
- Shared provider catalog/configuration/credential references, with operation-specific settings.
- Separate Search and Fetch settings tabs in DSH and the MCP resident settings UI.
- An agent-facing tool in both hosts using the same core implementation.
- A small initial set of provider adapters: target two verified providers; a third is optional only if necessary to cover a materially different format capability. Do not broaden beyond three.
- Backward-compatible loading of current saved configurations and regression tests.

Non-goals: recursive crawling, bulk URL fetching, parallel route/provider execution, article-only extraction, resource archives, arbitrary scripts or headers supplied by the agent, autonomous CAPTCHA solving, changing installed DSH artifacts, or redesigning unrelated settings.

## 3. Public API and host tools

Export a page-fetch engine/function and all public input/config/result types from core. Prefer a separate `PageFetchEngine` rather than embedding unrelated behavior into `SearchEngine`.

Conceptual API:

```ts
fetchPage({ url, format: 'html' | 'markdown' }, signal?)
```

`url` and `format` are required. Validate before any network request. No saved default format, and no implicit Markdown fallback. The agent chooses Markdown for reading and HTML for inspecting structure. Agent calls cannot override route order, provider selection, authentication, or safety policy in v1.

Use an unambiguous new tool name such as `web_extract` in both hosts. Do not collide with DSH's existing `web_fetch`, replace its provider, or change the existing activation action's fetch-provider selection. Tool descriptions must explain that Markdown is for reading, HTML for structure, and all returned content is untrusted.

Provide an explicit user-facing `tools.webExtract` boolean in shared configuration and both settings UIs. Default false for fresh configurations and migrated installations: tool exposure is opt-in, so agents with a stronger native fetch tool do not receive a duplicate automatically. Turning it off removes the tool from advertised schemas/tool lists, rather than exposing a tool that refuses execution. Apply changes through the host's supported lifecycle/tool-list update mechanism and test enable/disable transitions. Keep fetch configuration, credentials, manual user-triggered tests, and the library API available when agent-tool exposure is off; this switch controls exposure only, not route configuration. It never disables or changes another plugin/client's native fetch tool.

Core keeps policy/configuration separate from host storage, UI rendering, credentials, and filesystem delivery. A cancellation signal must propagate through every phase.

## 4. Unified provider model

### 4.1 Catalog capabilities are not user toggles

One provider ID identifies one catalog entry and one saved configuration record. Declare supported operations and native fetch formats in metadata; account for access-mode differences. A search-only provider must not become fetch-capable merely because a user selects it.

Do not overload the existing search-filter `capabilities` string list with an unrelated meaning. Extend metadata with typed operation definitions. Preserve existing public exports and search semantics where practical.

### 4.2 Configuration shape

Retain existing `backends` identity/credential names to avoid an unnecessary full search configuration rewrite. Extend each record with operation-specific fetch settings, or use an equivalent structure that preserves old search records during migration. There must be exactly one authoritative shared credential reference per provider by default.

Conceptually:

```text
provider record
  shared identity and credential lookup
  search settings (existing enablement and options)
  fetch settings (access mode, endpoint, timeout, options, local attempt caps)
page-fetch settings
  ordered route records with enablement and fallback rules
  selected provider ID
  total time/size/redirect/safety limits
  browser context policy
```

Sharing a provider does not imply sharing every endpoint, access mode, option, timeout, or price. Search and fetch often use different endpoints. Reuse genuinely common fields and credentials; keep operation-specific fields separate. Never reinterpret a saved custom search URL as a fetch endpoint by guessing string replacements.

Search enablement controls search only. The provider route selects exactly one fetch-capable record independently of search enablement. Providers may be configured without being selected. Selecting another provider preserves previous settings. Missing credentials can be shown as readiness errors, not embedded in configuration exports.

If verified provider contracts genuinely require distinct credentials, document the exception and use a fixed operation-specific credential name; do not add arbitrary user-controlled credential references. Do not create duplicate key forms for providers whose key is shared.

### 4.3 Migration

Loading old config must preserve search enabled flags, mode, endpoints, options, browser settings and credential names exactly, and add only missing fetch fields. Clone before migration. Explicit invalid new values must fail validation, not silently reset. Keep unknown-field checks where supported. Handle fetch-only catalog entries without accidentally including them in search fan-out or UI search lists.

Prefer additive changes and no package/version bump unless repository tooling actually requires one. Do not change package names or provider IDs.

### 4.4 Access-mode transports, per-mode evidence and the shared key

The access mode, not the provider, owns the transport. Declare `transport` per mode — `mcp` for one
JSON-RPC tool call, `rest` for the provider's documented HTTP operation — together with that mode's
own fetch endpoint. The engine reads the transport from the saved mode and passes it to the single
provider route. The MCP path never guesses a transport from an endpoint shape, a mode without an
adapter for its transport is refused instead of rerouted, and adding a REST mode never forks a second
provider route.

Evidence is per access mode. `live` means this deployment observed the contract; `documented` means
the mode was implemented from the provider's official API reference and no call was made — for
example because it would cost money and no spending was authorized. A documented mode carries its own
evidence date and has to be labelled as documented-only wherever it is shown; it must never inherit
the keyless mode's "checked" date or be described as verified. Its contract tests use fixtures built
from the documentation, and the evidence document says plainly what that does and does not prove.

One credential per provider stays the rule for keyed fetch modes: the fetch uses
`backendCredentialRef(providerId)`, exactly the reference the provider's search mode uses. No second
credential name and no second input box is introduced; the fetch card shows configured/not-configured
and links to the one credential control on the search card.

## 5. Route execution

Store exactly one instance of each route in a user-reorderable array. Enabled is independent of position. Skip disabled routes. Execute one at a time, never in parallel, including providers. There is no scan or automatic failover among provider records.

Defaults:

- Order: HTTP, browser, provider.
- HTTP on; browser and provider off.
- Default fallback rules: network error and per-route timeout only.
- Status/content presets are opt-in, editable ordinary rules.
- No implicit retries layered over the route chain in v1.
- No page cache in v1; never reuse the search result cache.

Reject all-routes-disabled configurations. Enabling the browser route requires a configured usable endpoint shape; enabling provider requires a selected fetch-capable provider. Credential availability can change at runtime and must be reported honestly: a keyed fetch mode with no stored key never sends an unauthenticated request. It reports an `authentication` attempt instead — a normal operational failure, not a configuration error and not fatal — so the route's own fallback rules decide whether the chain continues; the saved configuration stays valid, and the settings page reports the same gap as a readiness problem before a test is attempted.

Preflight request format compatibility before sending a route request. A Markdown-only provider cannot satisfy HTML: record `unsupported-format`, skip its request, and continue to the next enabled route. This is a capability skip, not a fabricated successful fetch or a switch to another provider.

Run configured fallback rules against every route's outcome. A matching rule continues; no match stops. A stopped 404/500 is still an HTTP-error result, not success. A matching content rule can reject a 200 response.

Fatal conditions cannot be overridden: caller cancellation, overall deadline, unsafe URL/policy denial, invalid global configuration, and resource safety violations. Release all route resources on every exit.

## 6. Result contract and stop semantics

Return bounded, JSON-safe results. Suggested fields:

```text
requestedUrl, finalUrl?, format, content?, contentRoute?, contentProvider?
representation? (response-html, rendered-dom, provider-html, provider-markdown)
statusCode? (target document only)
ok (acceptable successful result, not merely transport completion)
stopReason (accepted, stopped-on-error, exhausted, cancelled, deadline, policy, limit)
truncated
attempts[]
```

The implementation can use discriminated types while preserving these meanings. Input/config errors may throw typed errors before execution. Operational outcomes should retain structured diagnostics.

Each attempt includes route, optional provider ID, duration, outcome kind, target status if known, provider API status separately, rule IDs matched, unavailable rule inputs, and a sanitized error. Do not include full page copies or sensitive response headers in each attempt.

A successful result requires a successful target response when known, usable content, and no matched rejection/fallback rule. Unknown target status from a successful provider is not invented as 200; document its accepted provider-success semantics.

If fallback matches on the last usable route, return `exhausted` and `ok: false`. Preserve the last acquired page once as diagnostic content even if a later route has a network failure. Identify which attempt supplied that content; do not attach the later route's metadata to it. If no page was acquired, content is absent. A nonmatching HTTP error stops and returns its bounded body with `ok: false`.

Do not expose raw exception dumps, tokens, URL credentials, or provider response bodies in diagnostic error strings. Final URLs and page content may themselves be sensitive: do not persist them to logs by default.

## 7. Fallback rule language

Each route has a list of named rules. Rules are OR; conditions inside one rule are AND. No arbitrary nested expression editor, negation, or executable code in v1.

Condition types:

- Target main-document HTTP status membership, accepting integer codes 100–599 (including 200 when explicitly desired).
- Provider API HTTP status membership, valid only on provider route and separate from target status.
- Network exception, including DNS/connect/reset and browser transport/navigation network failure.
- Per-route timeout (separate from network failure).
- Typed provider/route operational error as needed for authentication/protocol failures; distinguish these from fatal configuration/policy failures.
- String match on `title`, `html`, `text`, or `markdown`, using `contains`, `equals`, or `regex`.

String conditions have explicit case sensitivity. Regex support must have bounded execution (a maintained linear-time engine or isolated terminable execution); `Promise.race` around synchronous JS RegExp is not protection. Validate supported syntax/flags on save. No raw user regex execution in the shared main event loop without a proven safe bound.

Use three-valued evaluation: true, false, unavailable. An AND rule matches only if every condition is true. Missing title/status/HTML is unavailable, not an empty string. Include unavailable field reasons in bounded diagnostics. Do not infer title from the first Markdown heading.

HTTP/browser checks run on available HTML/title/text before Markdown conversion and before output character truncation, but within acquisition/parser safety limits. Text excludes non-content and identifiable hidden nodes; it does not mean full browser CSS-equivalent visibility.

For a provider, use content and metadata from the same request. Native Markdown can be matched as `markdown`; HTML is unavailable unless that response also contains HTML. Do not issue an additional paid request solely to satisfy a rule. Do not make another provider call to obtain a missing title or target status. UI must warn about rules whose fields may be unavailable for the selected provider/format.

Provide an optional editable Cloudflare-challenge preset combining title and HTML markers to reduce false positives. Never trigger on the word `cloudflare` alone. Present it as heuristic detection, not guaranteed recognition or a promise of solving challenges. Presets have no hidden special behavior.

Bound rule/condition counts, input match lengths, regex lengths and parser work. Diagnostics say when a field was truncated or not fully inspected.

## 8. Formats and content processing

### HTML

Preserve page structure; do not strip scripts/styles/hidden elements from the HTML returned for structural inspection. HTTP returns decoded response HTML, browser returns a DOM snapshot, provider returns its declared HTML representation. These are different representations and must be labeled. Do not execute returned HTML or insert it unsanitized into either settings UI.

### Markdown

- HTTP/browser: parse HTML, remove scripts, styles, templates and identifiable hidden content, convert using maintained dependencies; preserve headings, links, lists, code and GFM tables where supported.
- Provider: request native Markdown whenever available; do not reconvert native Markdown.
- HTML-only provider: obtain HTML and use the local conversion pipeline.
- Markdown-only provider: cannot satisfy HTML; never reconstruct pretend source HTML.

No article-only Readability extraction by default: visible navigation/footer content may remain. Avoid claiming HTTP parsing can evaluate external CSS/JS visibility. Resolve relative links against the final/base URL consistently, with tests. Conversion failure is a typed operational error, not silent raw HTML in a Markdown field.

Reject binary downloads/PDF/image content with a clear unsupported-content result. Plain text can satisfy Markdown without HTML conversion; it cannot be represented as original page HTML without explicitly defining a different representation, which is outside v1. Validate format compatibility rather than inventing wrappers.

Before adopting dependencies, record maintenance/release/license/weight evidence and why the choice fits. Prefer established packages over a handwritten parser/converter. Do not vendor/fork patched dependencies.

## 9. HTTP route

Use Node's built-in fetch or an injected standards-compatible transport. No additional HTTP client merely for convenience. Support cancellation, bounded streaming reads, a declared product User-Agent, content-type and charset handling, and explicit manual redirect handling.

No site cookies/authorization by default, no user/agent arbitrary headers in v1, no cookie jar, no automatic cross-origin credential forwarding. Enforce limits before unbounded buffering. Treat HTTP error bodies as acquired responses, eligible for status/content rules.

Suggested defaults: total 90 seconds; route HTTP 20 seconds, browser 45 seconds, provider 30 seconds; maximum 5 redirects; acquired body 5 MB; output 100,000 characters; rule scan 100,000 characters. Validate documented finite bounds and explain acquisition-limit failure vs normal output truncation. Overall budget always bounds cumulative execution.

## 10. Browser route

Reuse the existing shared browser endpoint/token infrastructure, not an implicitly launched local browser. Inspect existing `BrowserSession` ownership before adapting it; do not hijack a site-specific page or weaken existing reader serialization.

Default to a dedicated isolated context/page without saved site login state. Allow an explicit persistent/session option using the configured state source; label its privacy implications. Reuse connection infrastructure where safe, not unrelated active pages. Account for the actual endpoint protocol; do not assume CDP and Playwright endpoints are interchangeable.

Navigate to DOMContentLoaded, with an optional bounded settle delay or explicitly configured selector wait; do not rely on unbounded network-idle. Capture main-document status only, title, final URL, DOM HTML. Subresource 404s are not main-document failures. Close page/context on success, fallback, cancellation, and errors without closing other clients' sessions.

Only target URL is sent to a provider after browser fallback; never forward browser cookies, HTML, or local session state to it.

## 11. Safety and privacy

Allow only HTTP(S) target URLs without embedded credentials. Reject unsupported schemes. Apply configurable public-only/private-network policy uniformly across routes and redirects. Default public-only. Explicit private-network opt-in must not expose credentials in diagnostics.

HTTP safety must account for resolved addresses, redirects, IPv4/IPv6 literals, localhost, private/link-local/metadata ranges and DNS rebinding; string hostname checks alone are inadequate. Browser documents and subresource network requests must not bypass the policy. Provider endpoint URLs are trusted operator configuration, distinct from untrusted target URLs.

A remote browser/provider may resolve DNS elsewhere. Do not claim local preflight proves its actual destination policy. If equivalent enforcement cannot be guaranteed, expose the trust boundary clearly and require explicit operator opt-in for delegated fetching rather than silently weakening public-only protection. Document the enforcement and residual limitations.

Decision (2026-11-18): the delegated opt-in is the route switch itself. Enabling a browser or provider route is that deliberate decision; the separate `pageFetch.allowDelegatedFetching` record was retired because it duplicated the route state and could contradict it. A saved switch is dropped on load, literal private/local targets are still refused before any route runs, and every result a delegated route produces carries the trust note.

Resource safety, cancellation, and policy errors cannot trigger another route. Do not persist full content in diagnostics, and do not log secrets. Any GUI preview is escaped text/code, never executable remote HTML. Preserve existing search/backend endpoint support for local self-hosted services; target-fetch policy must not retroactively block trusted search endpoints.

## 12. Settings UX in both hosts

Use the existing visual language/theme/locales. Add Search and Fetch tabs, not a disconnected second configuration store.

Search tab filters to search-capable entries and preserves existing behavior. Fetch tab contains:

1. Ordered route rows with independent toggles and keyboard-accessible move-up/down actions (drag optional, never exclusive).
2. Route-specific configuration and fallback rule editor using OR rule groups and AND conditions.
3. Fixed provider selector showing readiness and native/effective formats.
4. Fetch-capable provider settings, with shared credential/configuration indicators. Selecting a
   provider in the fixed selector must never unfold its card: the card stays collapsed, the selection
   is visible through its badge and the summary line, and only the user's own click opens the details.
   A keyed mode shows the status of the one shared credential and a link to the single credential
   control instead of a second key input.
5. Explicit test URL + required HTML/Markdown selector; test result and attempt trace. Paid/network tests are user-triggered, not automatic on render/save.

Shared settings use one authoritative draft across tabs. Switching tabs retains edits. Explain shared-field effects, distinguish search enabled from fetch selected, and never make changing the selected fetch provider toggle search participation.

All public settings have labels/help/defaults/validation, including security and rule limits exposed to users where appropriate. No generic JSON textarea as a substitute for the rule/config editor. Errors retain entered values and offer a focusable linked summary. Existing imports/exports/default/reset and credential redaction must still work. English and Chinese user-facing strings use existing locale mechanisms; code comments/logs/repository technical documents are English.

On narrow screens use stacked controls and contained code previews, without horizontal whole-page overflow. Use correct tab semantics, keyboard focus, disabled explanations, light/dark tokens and non-color-only status cues. MCP and DSH settings must round-trip the same core configuration.

## 13. Provider research gate

Before writing adapters, inspect official documentation and, when permitted without using stored paid credentials, verify live anonymous schemas. Record exact endpoints, operation/mode, request format, native outputs, target/API status distinction, credential reuse, pricing/quotas, evidence dates, and limitations in a repository document.

Prefer existing search providers to minimize new concepts. Candidate names from earlier discussion are not verified commitments. Choose two suitable providers from evidence; HTML-only or Markdown-only is allowed. Adding a fetch-only provider is acceptable if it materially improves coverage and does not require unrelated auth/UI redesign. If only one can be verified, implement one and explicitly report the unmet target; do not fabricate a second adapter. Mock contract tests do not count as live verification. Do not make paid calls, harvest existing profile credentials, or change deployment configuration to satisfy testing. When a keyed mode can only be implemented from documentation because no paid call is authorized, record it as `documented` with its own date, keep the anonymous mode's live evidence separate, and state in the evidence document exactly what was not observed.

## 14. Verification and acceptance

Core deterministic tests must cover:

- Required format/URL validation before requests.
- Reordered/disabled routes; no parallel execution; no unselected provider calls.
- Per-route OR/AND matching, unavailable fields, case sensitivity, bounded regex, invalid regex validation, title/entity handling, and Cloudflare false-positive fixtures.
- Target status distinct from provider API status; browser subresource failures ignored for status rules.
- 200 challenge fallback; nonmatching 404/500 stop with `ok: false`; no implicit retry.
- Local timeout fallback versus global cancellation/deadline stopping everything.
- Format capability skip without request; native Markdown not converted; HTML-only conversion; HTML structural preservation.
- Output truncation distinct from acquisition limits; diagnostic provenance after later network failure; exhausted routes not reported successful.
- Redirect limits/safety, private targets, DNS/address checks, delegated policy boundaries, and cancellation cleanup.
- Bounded parsing/conversion, relative links, tables/code, hidden/non-content filtering, non-HTML content handling.
- Browser context/page cleanup, isolation and explicit session mode with mocked transport; no site-reader regression.
- Provider request/response fixtures and sanitized errors for each supported adapter.
- Old config migration, preserved custom endpoints/keys/search behavior, invalid new configs rejected.

Host tests must assert required tool schemas and visibility, shared config/credential reuse, selected-provider readiness, tab/rule settings round trips, localized strings, test route results and secret redaction. Preserve existing tests and workspace resolution checks.

Run focused suites/typechecks during development. Final integration requires inspecting the complete diff and running the repository's check command when it is a bounded local operation; for a genuinely long full matrix, supply the exact user-run command and clearly state unverified coverage. Never equate a zero exit code with coverage: inspect assertions. Record actual commands/results and distinguish mocked, local HTTP fixture, and real remote integration evidence.

Do not claim installed GUI verification: deployment is not authorized. A source-level UI test/build is not verification of the current production URL. Final report includes remaining unverified live browser/provider/UI behaviors and any required opt-in test commands without secrets.

## 15. Implementation phases and completion report

1. Verify provider contracts, dependency options, host extension contracts and existing architecture; document choices.
2. Implement shared metadata/config migration and core routes/rules/conversion with deterministic tests.
3. Integrate DSH and MCP tools/settings/locales and migration regression tests.
4. Review diff, run checks, update package/readme documentation and produce an honest verification report.

The approved scope may proceed through these phases without repeated human confirmation. Report phase boundaries to the parent. Ask before material deviations, unsafe side effects or expanded scope. The implementation agent must not edit this specification silently: report proposed changes to the parent first.

The completion report lists changed areas, selected providers and evidence, chosen dependencies, exact tests and outcomes, security limitations, compatibility/migration details, and unverified live checks. Leave the worktree and branch intact; do not merge, push, publish, install into DSH, or restart services.
