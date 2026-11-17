# dsh-search

A TypeScript/TSX multi-backend search bundle for DeepSeek Harness 0.2.2-rc.3.

## Features

- 22 backend entries, independently enabled; explicit anonymous or key access where supported.
- No provider, credential, endpoint, or access-mode fallback.
- Bounded configurable HTTP retries, cancellation, deadlines and Retry-After handling.
- Cost tiers, dated quota disclosures and official references per access mode.
- Native Settings > Search management page, English/Chinese localization, editable public configuration, credential controls, validation, diagnostics and explicit trial searches.
- Parallel or single-backend search, deterministic URL/title deduplication and RRF/ordered fusion.
- Bounded in-memory cache; failures are never cached.
- Durable local attempt reservations, serialized before sending, grouped by backend and mode. UTC reset; these are not provider balances or monetary guarantees.
- Agent-visible partial and total failure explanations.

All backends are disabled on first installation. Enabling an account-backed backend may incur charges even when its platform advertises free credits. Stored keys never activate a backend automatically. Do not assume a supplier's internal routing is controlled by this plugin.

## Development

```sh
npm install --ignore-scripts --legacy-peer-deps
npm run check
```

DSH peer packages must resolve from the compatible installed runtime or a compatible development environment. The local installation used ignored symlinks to the installed DSH peers; these links are not portable build dependencies. Client React is supplied by DSH's module loader, never bundled twice. TypeScript, esbuild and tsx are development-only dependencies; runtime transport uses the platform Fetch API and Node crypto. DSH supplies its own configuration/credential/storage facilities and zod for durable record validation.

## Install and configure

Build first, then install this directory using DSH Plugin Manager. Open Settings > Search, select each backend's access mode, review pricing, set its endpoint/options and enable only the backends you want. Save before editing credentials or running an explicit test. Credential references are environment-style identifiers; secrets are saved through DSH's credential service, not exported in configuration. Removing a stored credential can reveal an ambient environment value again.

The bundle registers provider ID `nite-search` but does **not** change the active search/fetch selection or disable another plugin automatically. Migration must explicitly select the new provider while preserving the current fetch provider. Retain the old bundle disabled for rollback.

Tencent WSA uses one credential containing JSON `{"secretId":"...","secretKey":"..."}` and the official HTTPS API root. It does not use Bearer authentication.

## Limits and evidence

See [the backend contract and pricing audit](docs/BACKENDS.md), [the implementation plan](docs/PLAN.md), and [verification status](docs/VERIFICATION.md). Documentation verification, mock contract tests, real anonymous calls and paid-account validation are separate evidence levels. Keyed backends are not live-verified without credentials and explicit cost approval. HTML discovery and hosted MCP response formats may change; unknown payloads return a protocol failure rather than a false no-results success.

All public plugin configuration fields are form-editable; this does not mean every option exposed by every upstream vendor has been implemented. Unsupported generic filters are disclosed. Domain inclusion/exclusion is additionally enforced locally. Cache, diagnostics and circuit-breaker state are process-local; attempt reservations persist through configuration reloads. Durable usage is intended for one Host process, not coordinated account-wide limits across multiple DSH instances.

## Repository

- Origin: `mygit:nite/dsh-search.git`
- Development branch: `feat/search-plugin`, isolated under `.worktrees/`.
- No remote creation, push, merge or worktree removal without explicit approval.

## License

MIT. Original plugin icon; upstream service terms remain applicable.
