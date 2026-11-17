# dsh-search

English | [中文](README.zh.md)

A TypeScript/TSX multi-backend search bundle for DeepSeek Harness. Compatibility is verified against the running release rather than pinned to one version.

## Features

- 21 backend entries, independently enabled; explicit anonymous or key access where supported.
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

Install from npm (`@nite07/dsh-search`) or, when hacking on the source, build first and install this directory using DSH Plugin Manager. Open Settings > Search, select each backend's access mode, review pricing, set its endpoint/options and enable only the backends you want. Save before editing credentials or running an explicit test. Credential references are environment-style identifiers; secrets are saved through DSH's credential service, not exported in configuration. Removing a stored credential can reveal an ambient environment value again.

The bundle registers provider ID `nite-search` but does **not** change the active search/fetch selection or disable another plugin automatically. Migration must explicitly select the new provider while preserving the current fetch provider. Retain the old bundle disabled for rollback. The settings page reports which provider the web seam currently selects and offers a one-click switch when it is not this plugin.

Tencent WSA uses one credential containing JSON `{"secretId":"...","secretKey":"..."}` and the official HTTPS API root. It does not use Bearer authentication.

## Limits and evidence

See [the backend contract and pricing audit](docs/BACKENDS.md), [the implementation plan](docs/PLAN.md), and [verification status](docs/VERIFICATION.md). Documentation verification, mock contract tests, real anonymous calls and paid-account validation are separate evidence levels. Keyed backends are not live-verified without credentials and explicit cost approval. HTML discovery and hosted MCP response formats may change; unknown payloads return a protocol failure rather than a false no-results success.

All public plugin configuration fields are form-editable; this does not mean every option exposed by every upstream vendor has been implemented. Unsupported generic filters are disclosed. Domain inclusion/exclusion is additionally enforced locally. Cache, diagnostics and circuit-breaker state are process-local; attempt reservations persist through configuration reloads. Durable usage is intended for one Host process, not coordinated account-wide limits across multiple DSH instances.

Language and region use fixed canonical lists because providers disagree on spelling (`zh-hans` for Brave, `zh-cn` for Serper, `zh-CN` for SearXNG, upper-case primary tags for You.com). Each adapter translates the value or skips it with a warning.

## Repository

- Origin: https://git.nite07.com/nite/dsh-search（私有）
- Default branch: `main`
- Feature branches are cut from `main` and merged back with `--ff-only`.

## License

MIT. Original plugin icon; upstream service terms remain applicable.
