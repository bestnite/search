# Search

English | [简体中文](README.zh.md)

[![ci](https://github.com/bestnite/search/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bestnite/search/actions/workflows/ci.yml)
[![dsh-search](https://img.shields.io/npm/v/@nite07/dsh-search?label=dsh-search&style=flat-square&color=cb3837)](https://www.npmjs.com/package/@nite07/dsh-search)
[![websearch-mcp](https://img.shields.io/npm/v/@nite07/websearch-mcp?label=websearch-mcp&style=flat-square&color=cb3837)](https://www.npmjs.com/package/@nite07/websearch-mcp)
[![search-core](https://img.shields.io/npm/v/@nite07/search-core?label=search-core&style=flat-square&color=cb3837)](https://www.npmjs.com/package/@nite07/search-core)
[![license](https://img.shields.io/badge/license-MIT-3da639?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square)](package.json)
[![browser image](https://img.shields.io/docker/v/nite07/search-browser?label=browser%20image&style=flat-square&color=2496ed)](packages/core/image/README.md)

Web search you actually control. Pick the providers you want, see what each one costs before
enabling it, and read the exact reason when something fails. This repository contains the shared
engine plus the two ways to use it.

There are 24 backends, from keyless tiers to paid APIs; per-backend quotas, prices and the date they
were checked are in [BACKENDS.md](packages/dsh-search/docs/BACKENDS.md).

## Which package do I want?

| You want to… | Install | Where it lives |
| --- | --- | --- |
| Search inside DeepSeek Harness | `@nite07/dsh-search` | [packages/dsh-search](packages/dsh-search/README.md) |
| Give any MCP client a search tool | `@nite07/websearch-mcp` | [packages/websearch-mcp](packages/websearch-mcp/README.md) |
| Build your own client on top | `@nite07/search-core` | [packages/core](packages/core/README.md) |

Both DSH and the MCP server are thin shells over the same core, so a backend enabled in one behaves
the same in the other.

## Page fetching (optional)

The same core also fetches one page at a time through ordered, configurable routes — HTTP, the shared
browser, or one selected provider — with per-route fallback rules and HTML or Markdown output. The
DSH agent tool is called `web_extract`, and it starts **hidden**: turn on `tools.webExtract` in
the settings page before an agent can call it. MCP host integration is deferred until DSH user testing
is complete. Route order, provider selection, credentials and the
safety limits are saved configuration, not call parameters.

```text
web_extract(url, format)   format is required: markdown to read, html to inspect structure
```

Only one page per call, never a crawl; routes run one at a time, never in parallel; each result lists
every attempt with target status, provider API status, matched rules and a sanitized error. Public
targets only by default, with the connection pinned to the address that was validated. A provider or
remote browser resolves the target elsewhere, so those routes need an explicit delegated-fetching
opt-in. See the [design](docs/PAGE-FETCH-DESIGN.md), [provider evidence](docs/PAGE-FETCH-PROVIDERS.md)
and [dependency evidence](docs/PAGE-FETCH-DEPENDENCIES.md).

## Start here

**DeepSeek Harness**

```sh
dsh plugin add @nite07/dsh-search
```

Then open **Settings → Web search**, pick your backends, and save. The page has Search, Browser and
Page fetch tabs over one draft; saving a configuration that enables a browser-backed search or the
fetch browser route first proves the endpoint and stored token with a bounded, navigation-free attach.
Full walkthrough:
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
| [docs/PAGE-FETCH-DESIGN.md](docs/PAGE-FETCH-DESIGN.md) | page-fetch requirements and design |
| [docs/PAGE-FETCH-PROVIDERS.md](docs/PAGE-FETCH-PROVIDERS.md) | which fetch providers were verified, and how |
| [docs/PAGE-FETCH-DEPENDENCIES.md](docs/PAGE-FETCH-DEPENDENCIES.md) | conversion, parsing and regex dependency evidence |

## License

MIT; each package retains its original license.

## Friends

- [LINUX DO](https://linux.do) — the community where this project's backend survey started.
