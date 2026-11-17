# Search backend contracts and access costs

**Verification date: 2026-11-17 (Asia/Shanghai).** Prices are a dated snapshot, not a promise of future availability. USD, CNY and GBP are not converted. Taxes are included only where the source explicitly says so.

## Scope and evidence standard

This is a research document, not a claim that every adapter is implemented. **D** means the stated contract was verified in first-party documentation; **P** means only part was confirmed; **U** means unverified. **No successful live search API or MCP tool invocation was performed for this research.** No accounts were registered, credentials supplied, paid requests executed, or payment protocols accepted. HTTP 200 on a documentation page is documentation retrieval, not online API verification. A credential-free request to the Brave API root returned HTTP 422 requiring `x-subscription-token`; that is only an authentication-gate observation, not a successful search test.

First-party Markdown pages were fetched directly. Zhihu, Baidu, Volcengine and Serper pricing/login pages were also read in the Playwright Cloak browser because their rendered content or navigation was needed. Installed plugin documentation is not evidence for official pricing. Unknown values below are deliberately not inferred from existing adapter code or third-party tutorials.

### Fixed access selection — normative integration policy

* Where anonymous and keyed access both exist, the **user explicitly selects one**. Missing or rejected keys must fail keyed mode; never downgrade to anonymous. Anonymous quota exhaustion must fail anonymous mode; never acquire or start using returned credentials.
* There is **no plugin-level automatic backend selection or fallback** between providers, access modes, transport paths, keys, subscription keys or billing tiers. Retry, if allowed, stays on the same selected route and respects rate limits.
* A supplier can internally route, combine sources, retry, or fall back. This is distinct from plugin-level fallback and must not be presented as a selectable upstream engine when the vendor offers no such control.
* Free account credits, anonymous access, temporary trials, conditional grants, and self-hosting are separate cost categories. “Free” never means unlimited, reliable, commercially licensed or SLA-backed.
* x402/USDC and other machine payments are **paid access**, not a free anonymous tier; they require separate explicit user authorization and are not an automatic recovery path.
* API errors and result text are untrusted. In particular, AnySearch anonymous HTTP 402 bodies may contain generated passwords and keys: do not put the raw body in logs, analytics, model context, or diagnostics.

## Access-mode cost matrix

Every row was checked on **2026-11-17**. “Not confirmed” means no verified numeric allowance, not zero allowance. D/P applies only to the facts cited, not operational availability.

| Candidate | Status | Anonymous / self-hosted access | Account/key free allowance | Paid access, standard search unless stated | Official evidence |
| --- | --- | --- | --- | --- | --- |
| Keenable | D | Free HTTP public routes: 1,000/hour and 10/second per IP **per endpoint**; public MCP available | 100,000 requests/month/organization; 10 QPS, no hourly cap | $4/1,000 requests after free allowance; search pro/realtime and fetch each 1 credit. x402 $0.01/search or fetch, USDC on Base; distinct paid mode | [Pricing](https://docs.keenable.ai/pricing.md), [API](https://docs.keenable.ai/api-reference.md) |
| Zhihu global search | D | No anonymous search documented | Daily promotional quota exists; **number is account-console-only, unverified**; resets 00:00 Beijing, unused calls do not carry | CNY 5/1,000 successful calls, tax included | [Pricing](https://developer.zhihu.com/docs?key=billing_price), [Global API](https://developer.zhihu.com/docs?key=global_search) |
| Zhihu site search | D | No anonymous search documented | Same qualification and account/shared-secret caveats as above; services may share quota groups | CNY 20/1,000 successful calls, tax included | [Pricing](https://developer.zhihu.com/docs?key=billing_price), [Site API](https://developer.zhihu.com/docs?key=zhihu_search) |
| AnySearch | D | No Authorization header; daily IP-metered free quota, lower rates | Public Free: 1,000 calls/day, up to 10 QPS; keys under one account share quota; daily reset 00:00 UTC. Student/Developer verified plans: 2,000/day, 20 QPS, eligibility required | Pro currently $3/1,000 (crossed-out $5), prepaid non-expiring packs, up to 20 QPS. Pro calls used before daily free calls; vendor may switch account quota tier internally | [Authentication](https://www.anysearch.com/docs/auth.md), [Pricing](https://www.anysearch.com/pricing.md) |
| Linkup | D | No free anonymous tier documented. No-account x402 is paid | Professional-email signup gets $20; **eligible accounts** topped back up to $20/month, not unconditional $20/month for everyone | flash/fast/standard: $5/1,000 raw searchResults; $6/1,000 sourcedAnswer/structured. deep: $50/$55 per 1,000. x402 same rates with $0.01 minimum/request | [Pricing](https://docs.linkup.so/pages/documentation/platform/pricing.md) |
| Tavily | D | No anonymous REST tier documented | 1,000 credits/month, no card required | basic/fast/ultra-fast 1 credit, advanced 2. PAYG $0.008/credit ($8/$16 per 1,000 calls). Monthly Project $30/4,000, Bootstrap $100/15,000, Startup $220/38,000, Growth $500/100,000 credits | [Credits](https://docs.tavily.com/documentation/api-credits.md), [Search](https://docs.tavily.com/documentation/api-reference/endpoint/search.md) |
| Exa | D | Hosted MCP documented; anonymous quota/price not established here | $10 balance on signup and reset to $10 first of each month; first-team onboarding one-time $10 bonus; no payment method required | lite/legacy instant $4/1,000; auto/legacy fast $7/1,000; deep-lite/deep $12/1,000; legacy deep-reasoning $15/1,000. Base includes 10 results; each additional result $1/1,000; AI page summary $1/1,000 pages | [Pricing](https://exa.ai/docs/admin/pricing.md), [Search](https://exa.ai/docs/search/quickstart.md) |
| Baidu Qianfan search | D | No anonymous API tier documented; cloud account, identity/resource activation required | 1,500/month, issued about 50/day; default 3 QPS | Domestic standard CNY 0.036/call, enhanced 0.04, flagship 0.072; foreign enhanced 0.072. Resource packs and version deduction rules require separate billing review | [Official integration guide, updated 2026-11-13](https://cloud.baidu.cn/doc/qianfan/s/nmweljpt3) |
| Volcengine / Doubao search | D | No anonymous API tier documented | 500/month/account, shared Custom/Global, consumed first; default 10 QPS, Custom/Global rate pools independent | Custom/Global web CNY 0.020/call PAYG. Custom-only monthly packs: CNY 5.9/1,000 (50/day), 9.9/2,000 (100/day), 99.9/10,000 (500/day). Subscription and PAYG API keys are isolated; no automatic switch | [Custom API](https://docs.volcengine.com/docs/networked-search/networked-search?lang=zh), [Billing](https://docs.volcengine.com/docs/networked-search/online-search-product-billing?lang=zh) |
| Brave | D | No anonymous free search API documented | $5 credits/month automatically applied | Search $5/1,000, capacity 50 QPS. Answers is separate: $4/1,000 queries + $5/million input and output tokens, 2 QPS | [Pricing](https://api-dashboard.search.brave.com/documentation/pricing) |
| You.com | D | **MCP free profile only:** 100 queries/day, no key; not an anonymous REST allowance | REST docs advertise free signup credits but exact amount **unverified** here | Web Search $5/1,000 up to 100 results/call; full-page extraction adds $1/1,000 pages fetched live; cached pages carry no extraction fee | [MCP](https://you.com/docs/agents/mcp-server.md), [Billing](https://you.com/docs/administration/billing.md) |
| open-websearch (Aas-ee) | D project contract | Self-hosted scraper/MCP/daemon, no API key. Infrastructure/proxy/browser costs remain; engines can throttle/block; README says personal use only | Not a hosted commercial quota | No project per-query tariff documented; **not proof upstream scraping is licensed or unlimited** | [Project README](https://raw.githubusercontent.com/Aas-ee/open-webSearch/main/README.md), [Daemon API](https://raw.githubusercontent.com/Aas-ee/open-webSearch/main/docs/http-api.md) |
| Serper | P | No anonymous API allowance confirmed | 2,500 free queries, no card required; renewal/reset not confirmed | Starter $50/50k ($1/1k), 50 QPS; Standard $375/500k ($0.75/1k), 100 QPS; Scale $1,250/2.5m ($0.50/1k), 200 QPS; Ultimate $3,750/12.5m ($0.30/1k), 300 QPS. Credits valid 6 months; taxes excluded | [Official homepage pricing](https://serper.dev/) |
| Serpex | D | No anonymous API tier documented | 200 free credits/new account, no card | Plain search 1 credit. Top-up $5–49 approximately $0.80/1k; $50–499 ~$0.65/1k; $500–1,999 ~$0.50/1k; larger custom. Non-expiring. Same-organization identical requests repeated within 5 minutes free. Content add-ons may use more credits; read credits_used | [Pricing](https://serpex.dev/docs/getting-started/pricing), [Search](https://serpex.dev/docs/api/search) |
| Parallel | D | MCP web_search/web_fetch/web_decisions and fast image search free at lower rate limits; **numeric anonymous quota unverified**. REST requires key | Exact REST free allowance unverified | turbo/fast $1/1,000; basic/advanced $5/1,000; includes 10 results, extra results $1/1,000. Authenticated MCP billed at API rates after account allowance | [Pricing](https://docs.parallel.ai/getting-started/pricing.md), [MCP](https://docs.parallel.ai/integrations/mcp/quickstart.md) |
| Tencent WSA / Yuanbao Search | D | No anonymous tier documented | Free allowance unverified | CNY 14/1,000 lite, 20/1,000 standard, 26/1,000 flagship | [Product pricing](https://cloud.tencent.com/product/wsa), [SearchPro API](https://cloud.tencent.com/document/product/1806/121811) |
| DeepSeek | D | No anonymous API tier documented | Free allowance not confirmed | Raw Search and Fetch each $0.75/1,000 successful non-empty requests. Search 100 QPS/account, Fetch 25 QPS/account, independent. Model-hosted web tools add model-token costs | [Search & Fetch](https://api-docs.deepseek.com/guides/search/), [Web tools](https://api-docs.deepseek.com/guides/web_tools/) |
| DuckDuckGo | D limitation / U full SERP | Instant Answer API free; not full web search. HTML scraping is not an official full-results API contract | No numeric guaranteed quota; automatic throttling | No official paid full SERP tariff established; archived first-party docs say full results cannot be syndicated free or paid | [First-party API documentation source](https://raw.githubusercontent.com/duckduckgo/duckduckgo-publisher/master/share/site/duckduckgo/api.tx) |
| SearXNG | D project contract | Self-hosted metasearch; public-instance access/quota/auth determined by operator; many disable JSON | No universal hosted allowance | Software is self-hosted; infrastructure/upstream costs and terms remain. No universal per-query tariff | [Search API](https://docs.searxng.org/dev/search_api.html) |
| Mojeek | D | No anonymous API tier documented | Startup testing credit offered, **amount unverified**, bank card required | Startup GBP 2/1,000, 5 QPS, 100k/day, up to 10 results; Business GBP 3/1,000, 10 QPS, 400k/day, up to 40; Enterprise custom. Taxes excluded. Startup cache only one hour; Business/Enterprise indefinite storage rights | [Pricing and FAQ](https://www.mojeek.com/services/search/web-search-api/) |
| Anthropic | D | No anonymous Messages search documented | No universal free search allowance confirmed | $10/1,000 searches **plus model tokens including search content**; failed searches not billed. A model request may execute multiple searches | [Web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool.md) |
| OpenAI | D | No anonymous Responses search documented | No universal free API-search allowance confirmed | web_search $10/1,000 calls + search-content/model tokens; legacy preview non-reasoning $25/1,000 with free search-content tokens. For non-preview gpt-4o-mini/gpt-4.1-mini search content is a fixed 8k input-token block/call | [Pricing](https://developers.openai.com/api/docs/pricing.md), [Web search](https://developers.openai.com/api/docs/guides/tools-web-search.md) |

## Confirmed HTTP contracts

Unless stated otherwise, POST bodies use `Content-Type: application/json`. Examples below are **documented request shapes**, not requests executed by this research. Optional parameters are illustrative subsets; do not infer support for generic fields from another vendor.

### Keenable — D

* Keyed: `POST https://api.keenable.ai/v1/search`, `X-API-Key: <key>`; Bearer is also accepted, but X-API-Key wins if both are sent.
* Anonymous: `POST https://api.keenable.ai/v1/search/public`, **required** `X-Keenable-Title: <application name>` (or `keenable_title` query parameter), no key. Missing title returns 400.
* Body: `{"query":"...","max_results":5,"snippet_max_length":500,"mode":"pro"}`. Query required; max_results 1–50 (default 10); snippet_max_length 180–10000; mode pro/realtime (default pro); optional site, exclude_domains, publish/index date bounds, query_time, safety_mode and session_id.
* Response: `{query,mode,results:[{title,url,snippet?,published_at?,acquired_at?,description}],usage?}`. Description is deprecated and always empty; read snippet. Keyed usage reports sku/amount/credits/paid and possibly credits_remaining. Public response has no usage.
* Fetch: `GET https://api.keenable.ai/v1/fetch` or `/v1/fetch/public`, same mode-specific headers; query `url` required, max_chars/live/prompt optional. Response `{url,content,title?,author?,published_at?,truncated?,total_chars?,usage?}`.
* Errors include stable code/fix/retryable/docs_url. 402 is exhausted keyed credits; do not switch routes. Sources: [API](https://docs.keenable.ai/api-reference.md), [Search](https://docs.keenable.ai/api-reference/search.md), [Fetch](https://docs.keenable.ai/api-reference/fetch.md).

### Zhihu global and site search — D

Both use `Authorization: Bearer <Access Secret>`, `X-Request-Timestamp: <Unix seconds>`; docs also list Content-Type application/json. **GET query strings, no JSON body.**

* Global: `GET https://developer.zhihu.com/api/v1/content/global_search?Query=...&Count=5`. Count default 10, max 20. Optional SearchDB all/realtime/static (default all); optional Filter expression, URL-encoded, e.g. `host=="example.com" AND publish_time>=1778494631`. host supports ==/!=, publish_time numeric comparisons; AND/OR uppercase. **host=="zhihu.com" and its subdomains are unsupported: use site search instead.**
* Site: `GET https://developer.zhihu.com/api/v1/content/zhihu_search?Query=...&Count=5`. Count capped at 10; optional SortBy, e.g. `VoteUpCount:desc` or `CommentCount:none:(10,)`; fields are case-sensitive.
* Shared response envelope: `{Code:0,Message:"success",Data:{HasMore,Items:[{Title,Url,ContentText,ContentType,ContentID,...}]}}`. ContentText can contain `<em>` highlighting. Site Data also includes SearchHashId and optional EmptyReason; current site HasMore always false. Preserve provider URL/UTM provenance rather than inventing clean target links.
* Sources: [Global](https://developer.zhihu.com/docs?key=global_search), [Site](https://developer.zhihu.com/docs?key=zhihu_search), [Pricing](https://developer.zhihu.com/docs?key=billing_price). Their JS-rendered official contents were read with Cloak; no authenticated request was made.

### AnySearch — D

* `POST https://api.anysearch.com/v1/search`. Anonymous explicitly omits Authorization; keyed explicitly sends `Authorization: Bearer <key>`. Invalid key returns 401/403 and does not silently downgrade.
* Body: `{"query":"...","max_results":5}`. max_results 1–10/default 10; optional zone cn/intl, language, format json/markdown. For vertical capabilities, discover tag/params first; never fabricate capability tags. REST uses tag/params, **not MCP domain/sub_domain fields**.
* Response: `{code:0,message:"success",request_id,data:{results:[{title,url,snippet?,content?}],metadata:{total_results,search_time_ms}}}`. Title may be empty. Markdown changes result content, not the outer JSON envelope.
* HTTP 402 anonymous quota rejection can contain automatically generated credentials; rejected request is not executed. This plugin must not adopt them or resubmit under another mode. Keep diagnostics to status/request_id.
* Sources: [REST search](https://www.anysearch.com/docs/api-endpoints/v1-search.md), [Auth](https://www.anysearch.com/docs/auth.md), [Pricing](https://www.anysearch.com/pricing.md).

### Linkup — D

* `POST https://api.linkup.so/v1/search`, Bearer key.
* Body: `{"q":"...","depth":"standard","outputType":"searchResults","maxResults":5}`. q/depth/outputType required. depth flash/fast/standard/deep; outputType searchResults/sourcedAnswer/structured. Optional includeDomains (max 100), excludeDomains, fromDate/toDate, includeImages.
* Raw response `{results:[{type:"text",name,url,content,favicon,publishedAt?}]}`; image entries `{type:"image",name,url}`. sourcedAnswer returns `{answer,sources:[{name,url,snippet,favicon,publishedAt?}]}`. Structured output needs structuredOutputSchema and has a different schema; includeSources changes it again.
* API may return 402/payment-required for no-key x402. Account exhaustion is documented as 429. No mode switch on either.
* Sources: [OpenAPI reference](https://docs.linkup.so/pages/documentation/endpoints/search/reference.md), [Pricing](https://docs.linkup.so/pages/documentation/platform/pricing.md).

### Tavily — D

* `POST https://api.tavily.com/search`, `Authorization: Bearer <Tavily key>`.
* Body: `{"query":"...","search_depth":"basic","max_results":5,"auto_parameters":false}`. max_results 0–20; depth basic/fast/ultra-fast/advanced. Explicitly keep auto_parameters false for stable billing; automatic depth selection can cost 2 credits. Optional topic general/news/finance, domain filters, dates, include_raw_content and include_answer.
* Response `{query,results:[{title,url,content,score,raw_content?,published_date?}],images,response_time,answer?,usage?,request_id?}`. Read `content` for excerpt. include_usage true returns credits.
* Sources: [Search schema/auth](https://docs.tavily.com/documentation/api-reference/endpoint/search.md), [Billing](https://docs.tavily.com/documentation/api-credits.md).

### Exa — D

* `POST https://api.exa.ai/search`; Bearer key or x-api-key.
* Body: `{"query":"...","type":"lite","numResults":5,"contents":{"highlights":true}}`. Explicit type is a vendor search-depth setting, not plugin backend selection. Default auto exists, but do not silently pick it for a user-fixed lite configuration. Lite supports cached highlights/text and a smaller parameter set; unsupported options return 400.
* Response `{requestId,results:[{id,title,url,publishedDate?,highlights?:string[],text?,image?,favicon?}],searchTime?,costDollars?,resolvedSearchType?}`.
* numResults default 10; quickstart says up to 100, while pricing describes Enterprise access above 25: **account entitlement for large result counts unverified**. Keep conservative counts until entitlement is checked.
* Sources: [Search](https://exa.ai/docs/search/quickstart.md), [Pricing](https://exa.ai/docs/admin/pricing.md).

### Baidu Qianfan — D

* `POST https://qianfan.baidubce.com/v2/ai_search/web_search`, Bearer Qianfan API key.
* Body: `{"messages":[{"role":"user","content":"..."}],"search_source":"baidu_search_v2","edition":"standard","resource_type_filter":[{"type":"web","top_k":5}]}`.
* Official guide confirms response `references` array with title/website/url/snippet/date. Full response schema beyond that subset **unverified in this research**. Do not map it as an OpenAI choices envelope.
* Optional search_recency_filter week/month/semiyear/year is documented in the guide. The separately packaged Skill/MCP has count/freshness arguments; these are not proof that the raw API accepts those fields.
* MCP is Streamable HTTP with Bearer and tool webSearch `{query,count?,freshness?}`; exact MCP URL is to be copied from the logged-in tool detail page and remains **unverified**, not the REST URL.
* Source: [First-party integration guide](https://cloud.baidu.cn/doc/qianfan/s/nmweljpt3), rendered browser read.

### Volcengine / Doubao — D Custom, P Global

* Custom recommended API-key path: `POST https://open.feedcoopapi.com/search_api/web_search`, Bearer key.
* Alternative IAM AK/SK path: `POST https://mercury.volcengineapi.com?Action=WebSearch&Version=2025-01-01`, signed using service `volc_torchlight_api`. These are distinct fixed authentication routes.
* Body: `{"Query":"...","SearchType":"web","Count":5,"Filter":{"NeedUrl":true},"QueryControl":{"QueryRewrite":false}}`. Query 1–100 characters (excess truncated), Count default 10/max 50; optional TimeRange OneDay/OneWeek/OneMonth/OneYear or date interval; Filter Sites/BlockHosts/NeedContent; ContentFormats text/markdown. NeedUrl true removes cards without source URLs.
* Response `{ResponseMetadata:{RequestId,Error?},Result:{ResultCount,WebResults:[{Id,SortId,Title,Url?,Snippet,Summary?,Content?,PublishTime?,SiteName?,RankScore?}],SearchContext,TimeCost,LogId}}`. Result can be null on errors. Inspect ResponseMetadata.Error, not only HTTP status.
* Global pricing/free sharing confirmed; **its exact request endpoint/schema not separately verified**. Do not reuse Custom URL assuming it selects Global. Ark model tool-enabled search is also a separate integration, not interchangeable with Custom raw retrieval.
* Sources: [Custom API](https://docs.volcengine.com/docs/networked-search/networked-search?lang=zh), [Billing](https://docs.volcengine.com/docs/networked-search/online-search-product-billing?lang=zh), rendered browser reads.

### Brave — D

* `GET https://api.search.brave.com/res/v1/web/search`, `X-Subscription-Token: <key>`.
* Query parameters q required; count max/default 20, offset 0–9; optional country, search_lang, ui_lang, freshness, safesearch, extra_snippets=true. No JSON body.
* Response web.results entries `{title,url,description,extra_snippets?}`; query.more_results_available controls pagination. Other vertical enrichments are not ordinary web hits. LLM Context is a separate endpoint/product contract.
* Sources: [Web Search](https://api-dashboard.search.brave.com/documentation/services/web-search), [Pricing](https://api-dashboard.search.brave.com/documentation/pricing).

### You.com — D

* New integration: `POST https://ydc-index.io/v1/search`, `X-API-Key: <key>`. Existing GET remains supported but gets no new features. Do not replace this documented host with a guessed api.you.com REST path.
* Body: `{"query":"...","count":5,"strict_operators":true}`. Count 1–100; optional country/language/freshness/offset, include_domains or exclude_domains (not both), extraction. strict_operators defaults false: vendor can relax unmatched operators. Highlights extraction supports count at most 50.
* Response `{results:{web:[{url,title,description?,snippets?:string[],page_age?,contents?:{highlights?,markdown?,html?}}],knowledge?},metadata:{search_uuid?,query?,latency?}}`. Knowledge attribution is not a source URL.
* Full-page extraction's source cache/fetch/blend controls additional live-fetch charges. Do not enable paid extraction implicitly.
* Sources: [POST search](https://you.com/docs/api-reference/search/v1-search.md), [Billing](https://you.com/docs/administration/billing.md).

### open-websearch — D project interface, not engine-official SERP API

The candidate here is **Aas-ee/open-webSearch**, not the unrelated OpenWebSearch.eu initiative.

* User-configured local daemon URL; documented example `http://127.0.0.1:3210`, `POST /search`, no API auth documented. Body `{query,limit:1–50,engines:["duckduckgo"],searchMode:"request"}`. Do not assume all localhost daemons use that port.
* Envelope `{status:"ok",data:...,error:null,hint:null}`; README search payload example is array `[{title,url,description,source,engine}]`. Error envelope status error/data null/error `{code,message}`.
* MCP separate from daemon: local server `/mcp` Streamable HTTP or `/sse` legacy; stdio also available. Search tool accepts query, optional limit/engines/searchMode.
* Pin a single user-selected engine and forced request/playwright mode where relevant; do not leave request/browser strategy auto for fixed-mode use. Server README documents optional browser-cookie fallback for some fetch paths; do not imply all server behavior is under plugin control.
* Sources: [README with restrictions](https://raw.githubusercontent.com/Aas-ee/open-webSearch/main/README.md), [Daemon API](https://raw.githubusercontent.com/Aas-ee/open-webSearch/main/docs/http-api.md).

### Serper — P, protocol unverified from public official documentation

Pricing and free trial are confirmed on the official public homepage. The official playground redirects to login, so no public authenticated reference was obtained. **Endpoint, method, authentication header, request body, and full response contract remain unverified here.** Do not promote a familiar third-party `google.serper.dev` example or installed adapter implementation into official verification. The homepage shows an organic-style example but is insufficient to establish the exact production contract. Source: [Official homepage](https://serper.dev/), [Playground/login gate](https://serper.dev/playground).

### Serpex — D

* `POST https://api.serpex.dev/api/search` recommended; GET query parameters also supported. `Authorization: Bearer <key>`; x-api-key accepted alternatively.
* Body `{"q":"..."}`; optional include_content/content_results (5 or 10) incur different content costs. Do not assume a max_results parameter.
* Response `{id,query,engines,results:[{title,url,snippet,position,engine,content?|content_error?}],metadata:{number_of_results,credits_used,from_cache,status,...}}`.
* Vendor explicitly says legacy engine/engines are ignored and requests are internally routed with fallback. Plugin can select Serpex as a fixed provider, but cannot promise a fixed Serpex upstream engine. Date constraints can weaken when a vendor source lacks support. Use metadata.credits_used, not from_cache, for billing.
* Sources: [Search](https://serpex.dev/docs/api/search), [Pricing](https://serpex.dev/docs/getting-started/pricing). Plain-search pricing and content example differ; do not price content-enabled requests as necessarily one credit.

### Parallel — D

* `POST https://api.parallel.ai/v1/search`, `x-api-key: <key>`.
* Body `{"objective":"Find nonstop airlines between Seattle and Tokyo","search_queries":["Seattle Tokyo nonstop flights"],"mode":"fast","advanced_settings":{"max_results":5}}`. search_queries required, at least one concise keyword query; objective optional in REST, required in MCP. Modes turbo/fast/basic/advanced (REST default advanced). **max_results/source_policy/fetch_policy belong inside advanced_settings**, not top level. max_chars_total is top level.
* Response `{search_id,results:[{url,title?:string|null,publish_date?:string|null,excerpts:string[]}],session_id,warnings?,usage?:[{name,count}]}`. Required result fields are url and excerpts, not title. No invented content string.
* New integrations use v1, not a mechanical path substitution of a v1beta body. No language-model query rewrite was executed in this research; a plugin should not incur extra LLM calls silently.
* Sources: [Exact OpenAPI](https://docs.parallel.ai/api-reference/search/search.md), [Quickstart](https://docs.parallel.ai/search/search-quickstart.md), [Pricing](https://docs.parallel.ai/getting-started/pricing.md).

### Tencent WSA / Yuanbao Search — D

* `POST https://wsa.tencentcloudapi.com/`, JSON; Tencent TC3-HMAC-SHA256 signature from SecretId/SecretKey, service wsa. Headers X-TC-Action SearchPro, X-TC-Version 2025-05-08, X-TC-Timestamp, Authorization and Content-Type required. Region not required for SearchPro. **Not Bearer auth.**
* Body `{"Query":"..."}`; optional Mode 0/1/2, Site, Cnt 10/20/30/40/50, Industry, Freshness, Deeplinks; capabilities depend on purchased lite/standard/flagship version.
* Response `{Response:{Query,Pages:string[],Version,Msg?,RequestId}}`. Each Pages element is a **JSON-encoded string**, requiring separate parsing, containing title/url/date/passage, possibly content/score/pics/authority_level/deeplinks. Do not read Pages as an array of already-decoded objects.
* Sources: [SearchPro](https://cloud.tencent.com/document/product/1806/121811), [Common headers/signature](https://cloud.tencent.com/document/api/1806/121815), [Pricing](https://cloud.tencent.com/product/wsa).

### DeepSeek — D

As of this verification date DeepSeek **does have a first-party raw Search API**; older claims that it only provides model completions are stale.

* `POST https://api.deepseek.com/v1/tools/search`, Bearer API key.
* Body `{"query":"...","count":5,"need_content":false}`. Query 1–128 Unicode characters, count 1–50/default 10; optional ori_question and localization. Unknown body fields ignored.
* Response `{results:[{rerank_score,title,url,snippet,summary,content,site_name:string|null,site_icon:string|null,date:string|null,authority}]}`. content empty when not requested/unavailable. Empty results valid and unbilled.
* Fetch `POST https://api.deepseek.com/v1/tools/fetch`, `{url}` -> `{title,content}` Markdown. Same Bearer auth, separately limited and billed.
* Model-hosted deepseek_web_search/deepseek_read_url are different tools with model decision-making and token costs; raw Search is the deterministic adapter target.
* Sources: [Search & Fetch including billing/QPS](https://api-docs.deepseek.com/guides/search/), [Model web tools](https://api-docs.deepseek.com/guides/web_tools/).

### DuckDuckGo — D Instant Answers, U official full web search

* Official archived first-party source documents `GET https://api.duckduckgo.com/?q=...&format=json`, no key; descriptive t app identifier, optional no_html/no_redirect/skip_disambig. Response fields include AbstractText/AbstractURL, Results and RelatedTopics with FirstURL/Text (sometimes nested Topics).
* This **is not full search results**, does not syndicate general SERPs, and is often empty for non-topic queries. Documented attribution/noncommercial-approval restrictions and automatic throttling apply; exact current quota is unverified.
* html.duckduckgo.com/lite scraping is **not verified as an official API contract**, even if a scraper can return HTML. No stable official full-SERP response or paid tariff was confirmed.
* Source: [DuckDuckGo's own documentation repository](https://raw.githubusercontent.com/duckduckgo/duckduckgo-publisher/master/share/site/duckduckgo/api.tx). Its archival nature must be considered when evaluating current terms.

### SearXNG — D HTTP interface, P deployment-specific behavior

* User-configured instance: `GET /search?q=...&format=json`, or `POST /search` with **application/x-www-form-urlencoded**, not JSON. `/` also supports both methods. q required; format JSON must be enabled by the instance; disabled format returns 403.
* Optional categories/language/pageno/time_range/safesearch; engine-dependent filters may not be enforced by every underlying engine. No universal API-key scheme is defined by this search interface; an operator may add proxy authentication.
* JSON result projection convention `{results:[{title,url,content,...}],...}` is **not fully schema-verified by the Search API page used here**; confirm against selected deployment/version before strict validation. No instance was probed in this research. Never silently cycle through public instances.
* Source: [First-party Search API](https://docs.searxng.org/dev/search_api.html).

### Mojeek — D

* `GET https://api.mojeek.com/search?q=...&api_key=<key>&fmt=json`, key in query string. Avoid logging the URL with api_key. No JSON body.
* Official quickstart uses lb/lbb for language boosting and rb/rbb for region boosting. Other options must follow the request reference, not another provider's names.
* Response `{response:{status,head,results:[{url,title,desc,date?,timestamp?,pdate?,score?,...}]}}`. Check response.status, not just HTTP success.
* Sources: [Quickstart](https://www.mojeek.com/support/api/search/quickstart.html), [JSON response](https://www.mojeek.com/support/api/search/json_response.html), [Pricing/retention](https://www.mojeek.com/services/search/web-search-api/).

### Anthropic — D model-hosted search, not raw retrieval

* `POST https://api.anthropic.com/v1/messages`, x-api-key, anthropic-version (current documentation example 2026-10-21), Content-Type.
* Body includes explicitly chosen supported model, max_tokens, messages and `tools:[{"type":"web_search_20250305","name":"web_search","max_uses":1}]`. Newer 20260209/20260318 tools add dynamic filtering/response controls; do not silently upgrade versions. Model and organization capabilities must be checked.
* Response content includes server_tool_use, web_search_tool_result with array of `{type:"web_search_result",url,title,encrypted_content,page_age}`, plus text blocks/citations. Search errors can appear **inside HTTP 200** as web_search_tool_result_error; no search result may occur if the model does not search. Preserve encrypted fields unchanged for conversational continuation.
* Search result content is encrypted, **not a plaintext snippet**. Cited text is not a substitute for full raw retrieved content. A single model request can run several billable searches; max_uses bounds search calls, not model-token costs.
* Source: [Official web-search contract and pricing](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool.md).

### OpenAI — D model-hosted search, not raw retrieval

* `POST https://api.openai.com/v1/responses`, Bearer key, JSON with explicitly selected supported model, input and `tools:[{"type":"web_search"}]`; include `["web_search_call.action.sources"]` for complete consulted source lists. To require search rather than optional model choice, use documented tool_choice required or specific search-tool selection.
* Response output has web_search_call (action search/open_page/find_in_page) and message/content output_text with url_citation annotations `{url,title,start_index,end_index}`. Sources are not a guaranteed plaintext snippet list. Clickable inline citations must be shown when displaying results.
* external_web_access false is explicit cache-only mode; default true. search_context_size low/medium/high is not an exact result-count limit. Legacy web_search_preview lacks newer controls. Official docs say gpt-4o search previews shut down 2026-07-23; do not rely on them.
* Sources: [Guide](https://developers.openai.com/api/docs/guides/tools-web-search.md), [Pricing](https://developers.openai.com/api/docs/pricing.md).

## MCP contracts and transport rules

MCP is a transport/tool protocol, **not an additional search provider or free billing tier**. REST JSON bodies and MCP tool arguments must not be conflated.

Streamable HTTP sends JSON-RPC requests using POST, `Content-Type: application/json`, and `Accept: application/json, text/event-stream`. A server can reply as JSON or SSE. Initialize, send notifications/initialized, discover tools/list, then tools/call; retain Mcp-Session-Id if issued and negotiated MCP-Protocol-Version on subsequent requests. Tool results may have structuredContent, content text blocks, _meta and isError. A parseable HTTP 200 or MCP result is not by itself search success. Do not guess tool names or treat human-readable Markdown output as a stable raw JSON schema. Reference: [Official transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

| Provider | Fixed endpoint and access | Documented search tool arguments | Verification limitations / source |
| --- | --- | --- | --- |
| Keenable anonymous | `https://api.keenable.ai/mcp-public`; no key; avoids OAuth discovery | search_web_pages `{query,max_results?,snippet_max_length?,site?,exclude_domains?,output_format:"json",...}`; public schema does not list mode | Raw JSON is serialized inside tool text when requested; title/url/snippet shape as REST. No live tools/list done. [MCP docs](https://docs.keenable.ai/mcp-server.md) |
| Keenable key | `https://api.keenable.ai/mcp`, X-API-Key; /mcp-public also accepts key but should not be switched automatically | Same tool; keyed mode pro/realtime can be fixed. fetch_page_content `{url,max_chars?,live?,prompt?,output_format?}` | Keyed usage _meta["keenable/usage"]. OAuth is separate /mcp-oauth. [MCP docs](https://docs.keenable.ai/mcp-server.md) |
| AnySearch anonymous or key | `https://api.anysearch.com/mcp`; retain X-Anysearch-Client `mcp/1.0.0`; keyed mode adds Bearer | search `{query,max_results?:1–10,domain?,sub_domain?,sub_domain_params?}`; batch_search `{queries:[1–5 search objects]}`; get_sub_domains `{domain}` or `{domains}`; extract `{url}` | REST tag/params differ from MCP. Exact runtime result envelope still requires tools/list/call validation. [MCP docs](https://www.anysearch.com/docs/mcp-install.md) |
| Zhihu key | `https://developer.zhihu.com/api/mcp/v1`, Bearer Access Secret | Tool names zhihu_search/global_search/hot_list/zhida confirmed; **input schemas unverified** | Do not assume raw GET Query/Count are MCP names. [Unified MCP](https://developer.zhihu.com/docs?key=unified_mcp) |
| Linkup key | `https://mcp.linkup.so/mcp`, Bearer preferred over apiKey URL query | linkup-search `{query,depth?:"standard" or "deep",maxResults?,includeDomains?,excludeDomains?,fromDate?,toDate?,includeImages?}` | MCP exposes only standard/deep, unlike raw API flash/fast. No free anonymous demo confirmed. [MCP docs](https://docs.linkup.so/pages/integrations/mcp/mcp.md) |
| Parallel anonymous | `https://mcp.parallel.ai/mcp?tools=web_search`, no auth | web_search `{objective,search_queries:string[],client_model?,session_id?}`; objective and search_queries required | Default fast. No count/mode argument in anonymous tool schema; do not send unsupported max_results. Numeric anonymous allowance unverified. [MCP docs](https://docs.parallel.ai/integrations/mcp/quickstart.md) |
| Parallel key | Same endpoint, Bearer or x-api-key | Same core args; host can fix settings with x-parallel-mcp-config JSON header, e.g. `{"web_search":{"override":{"mode":"fast","advanced_settings":{"max_results":5}}}}` | Overrides require auth; anonymous with config header returns 401. _meta["parallel/usage"] reports costs. New unified endpoint replaces standalone search.parallel.ai/mcp for new setups, old endpoint still operates. [MCP docs](https://docs.parallel.ai/integrations/mcp/quickstart.md) |
| You.com anonymous | `https://api.you.com/mcp?profile=free`, no key, 100 queries/day | you-search `{query,count?,freshness?,offset?,extraction?,knowledge?,safesearch?,exclude_domains?,...}` | Free profile only you-search/you-discover. Deep argument schema should be discovered at runtime; do not infer REST extraction object matches MCP shorthand. [MCP docs](https://you.com/docs/agents/mcp-server.md) |
| You.com key | `https://api.you.com/mcp`, Bearer | you-search; host overrides in _meta["com.you.com/search"] or X-Search-* headers, e.g. country/language/count/include_domains | Bare no-key /mcp means OAuth, **not anonymous free mode**. [MCP docs](https://you.com/docs/agents/mcp-server.md) |
| Baidu | Streamable HTTP + Bearer; exact service URL unverified | webSearch `{query,count?:1–50,freshness?}` | Must obtain URL from official tool details, not repurpose REST URL. [Guide](https://cloud.baidu.cn/doc/qianfan/s/nmweljpt3) |
| Exa | `https://mcp.exa.ai/mcp` documented | Exact runtime tool/schema and anonymous allowance unverified here | The hosted endpoint mention alone does not prove free anonymous production service. [Search docs](https://exa.ai/docs/search/quickstart.md) |
| open-websearch | User-configured local /mcp Streamable HTTP, /sse legacy, or stdio | search `{query,limit?,engines?,searchMode?}` | Self-hosted scraper; fix deployment/mode/engine, not a universal hosted URL. [Project README](https://raw.githubusercontent.com/Aas-ee/open-webSearch/main/README.md) |

For all other candidates, a first-party MCP endpoint/schema was **not verified by this research**. This does not assert that none exists.

## Remaining verification work before production claims

1. With user-provided credentials and explicit cost approval, run a small successful query for each selected keyed provider and validate real response/error envelopes. Document the date, request mode and billed usage separately from this documentation-only audit.
2. Run initialize/tools/list and one explicitly authorized tool call for selected MCP routes, including both JSON and SSE response handling where supported. Anonymous tiers can still change or return sensitive quota errors.
3. Resolve Serper's login-gated official API contract; verify SearXNG JSON serialization against the exact selected instance; verify Doubao Global separately; retrieve Zhihu MCP input schemas and account-specific free limits.
4. Recheck prices at deployment and expose the selected access mode, free limitations, supplier-internal routing caveats, and verification date to the user. Never label an unverified endpoint as supported merely because its name appears in a catalog.
