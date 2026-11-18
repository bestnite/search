# Development

How the workspace is organised, how to build and test it, and how to publish. User-facing setup lives
in the [main README](../README.md) and each package README; this file is for people changing the code.

## Layout

```
packages/core            @nite07/search-core   backends, engine, browser sessions
packages/core/image      browser container      Patchright + Chrome + VNC + token proxy
packages/dsh-search      @nite07/dsh-search     DeepSeek Harness plugin
packages/websearch-mcp   @nite07/websearch-mcp  standalone MCP server
docs/                    this file, browser session internals, migration record
```

The workspace is private and never published. The three packages have independent names, exports and
versions; only the internal core dependency is linked.

## Commands

Requires Node.js 22 or newer and npm 10 or newer. Run everything from the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm run pack
```

- `npm run check` — builds core types, type-checks and tests every workspace, then runs all production
  builds and `verify:workspace`.
- `npm run pack` — writes three independently publishable archives to `.artifacts/`; it never
  publishes them.
- `npm run verify:workspace` — asserts that each host requires the exact core version, that the root
  lockfile links the workspaces, and that both hosts actually resolve the local core build.

Builds are ordered: core first, then the two hosts, because both consume core's declarations.

## Workspace rules

- One root lockfile. Do not create package-local lockfiles.
- Never replace the internal dependency with an absolute `file:` path; a published package must carry
  a normal semver requirement.
- Both hosts require the **exact** core version. npm resolves that matching version to the workspace,
  which is why `verify:workspace` can assert real module resolution instead of trusting the manifest.
- `packages/dsh-search` keeps its host APIs as peer dependencies. Its devDependencies pin the SDK
  build used for verification so a fresh clone type-checks without a DSH installation.
- The root `.npmrc` sets `legacy-peer-deps=true`. DSH host packages have a runtime-managed peer graph,
  and the registry `latest` tag can point at an incompatible generation; installing that whole graph
  would be both slow and wrong. This does not remove the plugin's published peer contract.

## Tests

Unit tests run in every package (`node --import tsx --test test/*.test.ts`).

The live browser integration test is opt-in and excluded from `npm test`; it is the only test that
touches a real browser, and it reads its endpoint from the environment rather than from any deployment
configuration:

```sh
BROWSER_WS_ENDPOINT=ws://127.0.0.1:3000/ws \
BROWSER_TOKEN=... \
BROWSER_STATE_PATH=/path/to/state.json \
  node --import tsx --test packages/core/test/browser-live.integration.ts
```

It caps itself at a handful of searches, never retries a rate-limit, authentication or challenge
answer, and prints only durations and counts — never a token, cookie or raw response.

## Release

Package versions stay independent so existing consumers keep working.

1. Change core's version and both hosts' exact core requirement together; bump the affected host
   versions.
2. Regenerate the root lockfile: `npm install --package-lock-only --ignore-scripts`.
3. Run `npm run check` and `npm run pack`; inspect the archives.
4. Publish core first, then the hosts:

```sh
npm publish --workspace @nite07/search-core --access public
npm publish --workspace @nite07/dsh-search --access public
npm publish --workspace @nite07/websearch-mcp --access public
```

A published version can never be reused, so publish only after the checks pass. A Git push is not a
release, and neither is a deployment: installed DSH plugins and running MCP servers keep their old
build until they are reinstalled or restarted.

The browser image is versioned separately — its tags track the Patchright driver, not the npm
packages. See [the image README](../packages/core/image/README.md).
