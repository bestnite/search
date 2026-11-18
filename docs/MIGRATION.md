# Repository migration

## Source snapshots

Imported on 2026-11-18. Each source received its version/dependency update before import:

| Package | Original repository | Original source tip | Version |
| --- | --- | --- | --- |
| core | `mygit:nite/search-core.git` | `e1f9e9c` | 0.1.6 |
| DSH plugin | `mygit:nite/dsh-search.git` | `a82af35` | 0.1.11 |
| MCP server | `mygit:nite/websearch-mcp.git` | `3e6ddcd` | 0.1.3 |

Both hosts now require exactly `@nite07/search-core@0.1.6`. All three were tested separately against that local core before migration. The monorepo uses npm workspace links, a root lockfile and a core-first build order instead of local development symlinks.

## History and credentials

Histories were imported with non-squashed Git subtrees under `packages/core`, `packages/dsh-search` and `packages/websearch-mcp`. Source repositories and remote branches were not rewritten or removed.

Before importing core, a disposable bare clone was filtered with `git-filter-repo` to remove `.xhs-keep.mjs` from all imported commits. A final reachable-object scan found the same credential in historical `.open.mjs`; that helper was also removed from the new migration branch's imported history. The final scan verified that neither helper nor the known credential value remains reachable from the monorepo branch. Filtering changed affected commit IDs; the original tips above are provenance, not necessarily the imported rewritten IDs. No credential value is recorded here. Original repositories may still contain that credential in history; rotating or revoking it is a separate operator action.

Only the filtered branch is imported; do not later attach an unfiltered core remote or push its legacy tags into this repository. A browser image tag can be created from the migrated tree after its build context is verified.

The original image workflow moved to root `.github/workflows/image.yml` and now uses `packages/core/image` as its build context. It remains a GitHub workflow for a possible mirror, not a claim that Gitea Actions has run it. No container rebuild, package publication or production restart was performed as part of migration.

## Package and host boundaries

- Package names, exports and host peer dependencies are retained.
- Versions remain independent; the root workspace is private and never published.
- Published host packages use an exact semver core dependency, not `file:` paths or workspace-only syntax.
- DSH SDK versions are pinned as development dependencies for reproducible checks; the DSH runtime still supplies peers.
- Existing deployments point at the old checkouts until deliberately updated. Moving their configuration or restarting them is outside the migration.

## Verification

Run from the root:

```sh
npm ci --ignore-scripts
npm run check
npm run pack
```

`verify:workspace` checks manifest/lock agreement and that both hosts really resolve the local core build. Packaging does not publish. Browser integration tests remain opt-in and are not rerun during repository migration.

## Page-fetch configuration (2026-11-18)

The page-fetch feature is additive to the saved configuration. Loading an older file now fills only
the fields it lacks:

- `pageFetch` with three route records (HTTP enabled, browser and provider off), no selected provider,
  the documented time/size/redirect limits and `allowPrivateNetworks` off.
- A saved `pageFetch.allowDelegatedFetching` is dropped on load. Enabling a browser or provider route is
  the delegated decision itself, so the separate switch was retired instead of being kept in sync with
  the routes it gated; the private-address policy and the per-result trust-boundary note are unchanged.
- `fetch` on every backend record, holding the operation's access mode, endpoint, timeout and options.
  Search settings, endpoints, options, browser settings and credential names are untouched.
- `tools.webExtract`, defaulting to `false`: the agent tool stays hidden until a user turns it on.

Explicit values are never replaced: a saved `null`, wrong type, unknown key or out-of-range number is
reported by validation instead of being reset. Credential names remain fixed in code, so a saved
reference still cannot redirect a lookup. No package version was bumped for this change.
