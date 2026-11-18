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

Before importing core, a disposable bare clone was filtered with `git-filter-repo` to remove `.xhs-keep.mjs` from all imported commits. That temporary helper contained a browser credential. Filtering changed affected core commit IDs; the original tip above is provenance, not the imported rewritten ID. No credential value is recorded here. Original repositories may still contain that credential in history; rotating or revoking it is a separate operator action.

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
