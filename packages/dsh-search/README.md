# Web Search

English | [中文](README.zh-CN.md)

Searches the web through the backends you enable, with each backend's price shown before you turn it on. Every backend starts disabled, and keyed modes may cost money.

## Features

- Search every backend you enable, with the access mode chosen per backend.
- See each backend's price tier and pricing source before you enable it.
- Test one backend and read recent outcomes inside the settings page.
- Fetch a page through HTTP, a browser or a provider, with fallback rules.
- Import and export settings; an export never contains saved secrets.

## Install

```sh
dsh plugin add @nite07/dsh-search
```

DeepSeek Harness 0.2.2-rc.4 or a later 0.2 version is required, and Node.js 22 or newer must be available where DSH runs. Restart DSH, then open **Settings → Web Search**.

## Use

1. On the **Search** tab, enable a backend and check the cost shown on its row.
2. If the mode needs a key, enter it on the backend's card. It is stored once and never displayed.
3. Press **Save settings**.
4. If the page says another provider is active, press **Use this plugin for web search**.
5. Ask the agent to search.

The agent can:

- search every backend you enabled;
- read one X post, one Xiaohongshu note or one Reddit thread, with the matching backend enabled;
- fetch one page as Markdown or HTML, once **Allow web_extract** is on.

## Settings

The settings page is at **Settings → Web Search**. Each tab covers one part:

| Tab | What it covers |
| --- | --- |
| **Search behavior** | Query options, deduplication and the search tool switches |
| **Reliability** | Retries, circuit breaker, cache and diagnostics retention |
| **Test & diagnostics** | Backend tests, recent outcomes, import, export and defaults |
| **Search** | Backends, access modes, prices, endpoints and credentials |
| **Browser** | Shared browser endpoint, token, session file, read timeout and read limits |
| **Page fetch** | Fetch routes, fallback rules, provider, timeouts and output limits |

## Limits

- A failed backend is reported in the result; no other backend replaces it.
- Keyed modes may cost money, and a configured retry or a test can be billed too.
- Browser fetching and Xiaohongshu use a browser you host. Xiaohongshu needs your own sign-in, and a connection check does not sign you in.
- Some sites refuse automated access, so a fetch can fail even when a route is configured.

## License

MIT. See [LICENSE](LICENSE) for the full text.
