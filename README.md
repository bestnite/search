# Search

English | [简体中文](README.zh.md)

Web search you actually control. Pick the providers you want, see what each one costs before
enabling it, and read the exact reason when something fails. This repository contains the shared
engine plus the two ways to use it.

## Which package do I want?

| You want to… | Install | Where it lives |
| --- | --- | --- |
| Search inside DeepSeek Harness | `@nite07/dsh-search` | [packages/dsh-search](packages/dsh-search/README.md) |
| Give any MCP client a search tool | `@nite07/websearch-mcp` | [packages/websearch-mcp](packages/websearch-mcp/README.md) |
| Build your own client on top | `@nite07/search-core` | [packages/core](packages/core/README.md) |

Both DSH and the MCP server are thin shells over the same core, so a backend enabled in one behaves
the same in the other.

## Start here

**DeepSeek Harness**

```sh
dsh plugin add @nite07/dsh-search
```

Then open **Settings → Web search**, pick your backends, and save. Full walkthrough:
[dsh-search README](packages/dsh-search/README.md).

**MCP client**

```sh
npm install -g @nite07/websearch-mcp
websearch-mcp --print-config > ~/.config/websearch-mcp/config.json
```

Edit that file to enable backends, then point your client at the `websearch-mcp` command. Full
walkthrough: [websearch-mcp README](packages/websearch-mcp/README.md).

**Your own code**

```sh
npm install @nite07/search-core
```

Start with the runnable example in the [core README](packages/core/README.md).

## What you get

- **Explicit access mode per backend.** Anonymous, key, OAuth or a session cookie — exactly the mode
  you chose. No silent fallback between modes, keys or endpoints.
- **Visible cost.** Every mode carries a cost tier and a dated quota note, so nothing gets enabled
  before you know what it bills.
- **Honest failures.** A partial failure returns what worked and names what did not; a total failure
  says the search failed instead of returning an empty list.
- **Browser-backed sites.** Xiaohongshu only answers its own page runtime, so it reads through a
  browser container you host. The image, the VNC sign-in and the endpoint token are all in this repo:
  [browser image](packages/core/image/README.md).

There are 24 backends, from keyless tiers to paid APIs. The per-backend quotas, prices and the date
they were checked: [BACKENDS.md](packages/dsh-search/docs/BACKENDS.md).

## Documentation

| Page | For |
| --- | --- |
| [packages/core](packages/core/README.md) | library API, engine, backend catalog |
| [packages/core/image](packages/core/image/README.md) | running the browser container and signing in |
| [packages/dsh-search](packages/dsh-search/README.md) | DSH plugin, settings screen, agent tools |
| [packages/websearch-mcp](packages/websearch-mcp/README.md) | MCP server, config file, client setup |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | workspace layout, build, test, release |
| [docs/BROWSER-SESSIONS.md](docs/BROWSER-SESSIONS.md) | browser session internals |
| [docs/MIGRATION.md](docs/MIGRATION.md) | why this is a monorepo, and its history |

## License

MIT; each package retains its original license.

## Friends

- [LINUX DO](https://linux.do) — the community where this project's backend survey started.
