# Search

One repository for the search engine and its two hosts. Package names and public APIs remain independent; npm workspaces link the exact local core version during development.

| Package | Location | Version | Purpose |
| --- | --- | --- | --- |
| `@nite07/search-core` | [packages/core](packages/core/README.md) | 0.1.6 | Backend catalog, search engine, browser sessions and readers |
| `@nite07/dsh-search` | [packages/dsh-search](packages/dsh-search/README.md) | 0.1.11 | DeepSeek Harness plugin and Web settings |
| `@nite07/websearch-mcp` | [packages/websearch-mcp](packages/websearch-mcp/README.md) | 0.1.3 | Standalone MCP server |

## Development

Use Node.js 22 or newer and npm 10 or newer. Run commands from the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm run pack
```

There is one root lockfile. Do not create package-local lockfiles or replace internal dependencies with absolute `file:` paths. Both hosts require the exact core version; npm resolves that matching version to the local workspace. `npm run verify:workspace` checks those constraints and actual module resolution.

Builds are ordered: core first, then the two hosts. `npm run check` builds core types before checking/testing hosts and finishes with all production builds and dependency checks. `npm run pack` writes three independently publishable archives to `.artifacts/`; it never publishes them.

The DSH package keeps its host APIs as peer dependencies. Its development dependencies pin the SDK versions used for verification. The root `.npmrc` uses `legacy-peer-deps=true`: DSH host packages have a runtime-managed peer graph and registry `latest` tags can point to older, incompatible generations. This setting avoids installing that entire host graph; it does not remove the plugin's published peer contract. No SDK is loaded from a developer-specific filesystem path.

## Browser image

The browser container source remains under [packages/core/image](packages/core/image/README.md). Its driver version and `browser-v*` image tags are independent of package versions. Building or deploying the image is not part of `npm run check`.

Live browser tests are opt-in and excluded from normal tests. See [core browser testing](packages/core/README.md). Never commit endpoint credentials, cookies or captured site responses.

## Release

Package versions remain independent to preserve existing consumers. For a core update:

1. Change core's version and both hosts' exact core dependency together; bump affected host package versions.
2. Regenerate the root lockfile with `npm install --package-lock-only --ignore-scripts`.
3. Run `npm run check` and `npm run pack`; inspect the archives.
4. Publish core first, then the hosts, only with explicit release authorization.

A Git push is not an npm release or deployment. Installed DSH plugins and running MCP servers do not update automatically.

## Migration

The three original repositories were imported with their histories, without squashing. The old remotes remain untouched. The imported core history excludes a temporary credential-bearing helper; see [migration record](docs/MIGRATION.md) for provenance and verification boundaries.

MIT; each package retains its original license.
