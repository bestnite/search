# Response field mapping

Which response key each adapter reads for a result's title, URL, body and date. Verified against the
vendor's own documentation on 2026-11-18. When a provider renames a field, only this table and the
matching `sources()` call change.

The normaliser lives in `packages/core/src/adapters.ts`:

- A key may be a candidate list. The first populated value wins, so a provider that sends either
  `summary` or `snippet` keeps working without a code branch.
- `url` is mandatory. A row without a valid http(s) URL is dropped.
- `title`, `snippet` and `date` are optional. A wrong key is therefore silent: nothing throws, the
  field is simply missing from every source. That is why this table is checked against docs rather
  than against a successful request.
- Dates may be ISO strings or unix seconds/milliseconds; numbers are converted to ISO. Anything else
  is dropped instead of being guessed at, so a provider with only a numeric timestamp needs that key
  named explicitly.

## Adapters

| Backend | Rows | title | snippet | date | Status |
| --- | --- | --- | --- | --- | --- |
| keenable | `results` | `title` | `snippet` (`description` is deprecated) | `published_at` | verified |
| anysearch | `data.results` | `title` | `snippet`, `content` | none documented | verified |
| linkup | `results` | `name` | `content` | `publishedAt` | verified |
| tavily | `results` | `title` | `content` | `published_date` | verified |
| brave | `web.results` | `title` | `description` | `page_age` | verified |
| serper | `organic` | `title` | `snippet` | `date` | unverified: docs are login-gated, no public response contract |
| mojeek | `response.results` | `title` | `desc` | `date` | verified |
| serpex | `results` | `title` | `snippet` | none documented | verified |
| searxng | `results` | `title` | `content` | `publishedDate` | verified |
| exa (key) | `results` | `title` | `text` | `publishedDate` | verified |
| parallel (key) | `results` | `title` | `excerpts` joined | `publish_date` | verified |
| you (key) | `results.web` | `title` | `description` | `page_age` | verified |
| baidu | `references` | `title` | `snippet`, then `content` | `date` | verified: the documented example populates `content` only |
| doubao | `Result.WebResults` | `Title` | `Summary`, then `Snippet` | `PublishTime` | verified: the vendor names `Summary` as the body for model input |
| zhihu-web, zhihu-site | `Data.Items` | `Title` | `ContentText` | `PublishTime`, `EditTime`, `CreateTime` | verified: only numeric timestamps exist, so the ISO date comes from conversion |
| open-websearch | `data.results` | `title` | `description` | none | verified: the envelope is `{status, data:{results}}` |
| deepseek | `results` | `title` | `snippet` | `date` | verified |
| anthropic | `content[]` → `web_search_tool_result.content[]` | `title` | none: the block is `{type,title,url,page_age,encrypted_content}` | `page_age` | verified |
| openai | `output[].content[].annotations[]` where `type==='url_citation'` | `title` | none | none | verified: the annotation is exactly `{start_index,end_index,title,type,url}` |
| tencent-wsa | `Response.Pages[]` (JSON-encoded strings) | `title` | `passage` (dynamic `content` kept as summary) | `date` | verified |
| exa, parallel, you (anonymous MCP) | `results`, or a JSON string in `content` | `title` | first of `snippet`, `snippets`, `text`, `description`, `summary`, `excerpt(s)`, `highlights`, `content`, `body` | first of `published_at`, `publishedAt`, `publishedDate`, `published`, `page_age`, `date` | verified: these MCP servers disagree on field names, so the mapper accepts all of them |

DuckDuckGo has no API: its adapter scrapes `result__a` anchors and `result__snippet` blocks, so it is
not covered by this table. Reddit, X and Xiaohongshu have their own modules (`reddit/`, `x/`, `xhs/`)
with their own mapping and are audited there.

## Known gaps that are not bugs

- `openai`: a URL citation carries a title and a URL and nothing else. No snippet or date exists to
  map, so every OpenAI source is title plus link.
- `anthropic`: a search result block carries a title, a URL and `page_age`, and the page text is only
  available as `encrypted_content`, which is not usable here. Sources have no snippet.
- `serper`: no public response contract to verify against; the current keys follow the vendor's
  homepage sample and must stay marked unverified.

## Documentation checked

keenable `docs.keenable.ai/api-reference/search`, anysearch `anysearch.com/docs/api-endpoints/v1-search`,
linkup `docs.linkup.so` search reference, tavily `docs.tavily.com` search endpoint, brave
`api-dashboard.search.brave.com/api-reference/web/search`, mojeek `mojeek.com/support/api`,
searxng `docs.searxng.org/dev/result_types`, exa `api.exa.ai/openapi.json`, parallel
`docs.parallel.ai/public-openapi.json`, you `you.com/docs/guides/search`, baidu `cloud.baidu.com`
qianfan ai_search, doubao `volcengine.com/docs` networked search, zhihu `developer.zhihu.com/docs`
global_search and zhihu_search, tencent `cloud.tencent.com/document/product/1806`, deepseek
`api-docs.deepseek.com/api/search`, anthropic and openai SDK typings plus their official tool docs,
open-websearch `github.com/Aas-ee/open-webSearch` HTTP API doc and protocol types.
