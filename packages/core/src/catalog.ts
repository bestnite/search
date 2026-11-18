import type { FetchOperationDefinition } from './fetch/types.js';
import type { BackendDefinition, Localized, ModeDefinition, OptionField } from './types.js';
const text = (en: string, zh: string): Localized => ({ en, zh });
const option = (key: string, label: string, zh: string, value: string | number | boolean, choices?: string[]): OptionField => ({ key, type: choices ? 'select' : typeof value as 'string' | 'number' | 'boolean', label: text(label, zh), help: text(`Native ${key} parameter. See the backend documentation.`, `原生 ${key} 参数，详见后端文档。`), default: value, ...(choices ? { choices } : {}) });
const mode = (access: ModeDefinition['mode'], endpoint: string, tier: ModeDefinition['tier'], en: string, zh: string, pricingUrl: string, shape?: { en: string; zh: string }): ModeDefinition => ({ mode: access, endpoint, tier, limits: text(en, zh), pricingUrl, ...(shape ? { credentialShape: text(shape.en, shape.zh) } : {}) });
const backend = (id: string, title: string, docs: string, modes: ModeDefinition[], options: OptionField[] = [], capabilities: string[] = [], status: BackendDefinition['status'] = 'documented', evidence: BackendDefinition['evidence'] = 'documented'): BackendDefinition => ({ id, title, docs, modes, options, capabilities, status, evidence, verifiedAt: '2026-11-17' });
export const catalog: BackendDefinition[] = [
  backend('keenable', 'Keenable', 'https://docs.keenable.ai/api-reference/search.md', [mode('anonymous','https://api.keenable.ai/v1/search/public','free','1,000 requests/hour and 10/second per IP/endpoint; public title header required.','每 IP／端点 1000 次/小时、10 次/秒；需要公开调用标识。','https://docs.keenable.ai/pricing.md'),mode('key','https://api.keenable.ai/v1/search','allowance','100,000 searches/month free; then $4/1,000. Confirm current account terms.','每月 10 万次免费，其后 $4/千次；以账户当前条款为准。','https://docs.keenable.ai/pricing.md')],[option('clientTitle','Client title','调用方名称','dsh-search'),option('snippet_max_length','Snippet maximum length','摘要最大长度',2000)],['includeDomains'],'documented','live'),
  backend('anysearch','AnySearch','https://anysearch.com/docs/api-endpoints/v1-search.md',[mode('anonymous','https://api.anysearch.com/v1/search','free','Anonymous access needs no key, metered per IP with lower rate limits and a daily free reset (UTC). No account or credential is created automatically.','匿名访问无需密钥，按 IP 计量、限流更低、每日（UTC）重置；不会自动创建账户或密钥。','https://anysearch.com/pricing.md'),mode('key','https://api.anysearch.com/v1/search','allowance','Free plan: 1,000/day, 10 QPS; Pro calls have separate pricing.','免费档 1000 次/天、10 QPS；Pro 调用另行计费。','https://anysearch.com/pricing.md')],[option('zone','Zone','搜索区域','intl',['intl','cn'])],['language'],'documented','live'),
  backend('linkup','Linkup','https://docs.linkup.so/pages/documentation/endpoints/search/reference.md',[mode('key','https://api.linkup.so/v1/search','allowance','Eligible professional email accounts may receive $20/month. Raw search: $0.005/call; deep $0.05/call.','符合资格的专业邮箱账户可能享有每月 $20；普通搜索 $0.005/次，deep $0.05/次。','https://docs.linkup.so/pages/documentation/platform/pricing.md')],[option('depth','Search depth','搜索深度','standard',['flash','fast','standard','deep'])]),
  backend('tavily','Tavily','https://docs.tavily.com/documentation/api-reference/endpoint/search',[mode('key','https://api.tavily.com/search','allowance','1,000 free credits/month; basic 1 credit, advanced 2. PAYG $0.008/credit.','每月免费 1000 credits；basic 1 credit，advanced 2；按量 $0.008/credit。','https://www.tavily.com/pricing')],[option('search_depth','Search depth','搜索深度','basic',['basic','advanced']),option('topic','Topic','主题','general',['general','news','finance']),option('include_answer','Include answer','包含答案',false)],['includeDomains','excludeDomains','recency']),
  backend('exa','Exa','https://docs.exa.ai/reference/search',[mode('anonymous','https://mcp.exa.ai/mcp','free','Official free keyless MCP: no API key or sign-in, search and fetch at a free rate limit (no published number). Keyless needs a direct IPv4 connection; proxied or IPv6 paths get 403. Result quality and latency were the best of the free tiers in local testing.','官方免费无 Key MCP：无需密钥或登录，搜索与抓取按免费限流（未公布数值）。无 Key 需要直连 IPv4，代理或 IPv6 路径会返回 403。本机实测中其质量与延迟在免费档里最好。','https://exa.ai/docs/get-started/exa-mcp'),mode('key','https://api.exa.ai/search','allowance','$10 balance reset monthly; auto search $7/1,000 up to 10 results, extra results cost more.','每月余额重置为 $10；auto 搜索 $7/千次（最多 10 结果），额外结果另计费。','https://exa.ai/pricing')],[option('type','Search type','搜索类型','auto',['auto','neural','fast']),option('textMaxCharacters','Text maximum characters','正文最大字符数',2000)],['includeDomains','excludeDomains','recency'],'documented','live'),
  backend('parallel','Parallel','https://docs.parallel.ai/search/search-quickstart',[mode('anonymous','https://mcp.parallel.ai/mcp','free','Free anonymous MCP with lower rate limits; numeric quota is not published.','免费匿名 MCP，限流更低；数值额度未公布。','https://parallel.ai/pricing'),mode('key','https://api.parallel.ai/v1/search','paid','API usage is billed under account pricing; credits are not guaranteed.','API 按账户价格计费，不保证赠送额度。','https://parallel.ai/pricing')],[option('mode','Search mode','搜索模式','fast',['fast','turbo','basic','advanced']),option('maxCharactersPerResult','Maximum characters per result','每条结果最大字符数',2000)],[],'documented','live'),
  backend('brave','Brave Search','https://api-dashboard.search.brave.com/app/documentation/web-search/get-started',[mode('key','https://api.search.brave.com/res/v1/web/search','allowance','$5 monthly credits; $5/1,000 searches, 50 QPS. Check card/activation requirements.','每月 $5 credits；$5/千次搜索、50 QPS；需核对绑卡与激活要求。','https://brave.com/search/api/')],[],['language','region','recency','safeSearch']),
  backend('searxng','SearXNG','https://docs.searxng.org/dev/search_api.html',[mode('anonymous','http://127.0.0.1:8385/search','self-hosted','No vendor per-call fee; infrastructure costs and instance rate limits apply. JSON output must be enabled.','无厂商调用费，有自建运行成本及实例限流；需开启 JSON 输出。','https://docs.searxng.org/'),mode('key','http://127.0.0.1:8385/search','self-hosted','For an instance explicitly protected by a Bearer-auth gateway; not a native SearXNG API-key feature.','仅适用于自行配置 Bearer 鉴权网关的实例；不是 SearXNG 原生 Key 功能。','https://docs.searxng.org/')],[option('engines','Engines','引擎列表',''),option('categories','Categories','分类','general')],['language','recency','safeSearch'],'documented','live'),
  backend('ddg','DuckDuckGo','https://duckduckgo.com/duckduckgo-help-pages/results/syndication/',[mode('anonymous','https://html.duckduckgo.com/html/','free','HTML discovery, no SLA or guaranteed quota; blocking/challenges may occur.','HTML 搜索，无 SLA 或保证额度；可能限流或出现验证码。','https://duckduckgo.com/')]),
  backend('mojeek','Mojeek','https://www.mojeek.com/services/search/web-search-api/',[mode('key','https://api.mojeek.com/search','paid','API plan pricing applies. Do not assume a perpetual free quota.','按 API 套餐计费，不承诺长期免费额度。','https://www.mojeek.com/services/search/web-search-api/')],[],[]),
  backend('anthropic','Anthropic','https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool',[mode('key','https://api.anthropic.com/v1/messages','paid','Web search fees plus model input/output tokens.','搜索工具费用加模型输入／输出 token 费用。','https://platform.claude.com/docs/en/about-claude/pricing')],[option('model','Model','模型','claude-sonnet-4-6'),option('maxTokens','Maximum output tokens','最大输出 tokens',2048),option('maxUses','Maximum search uses','最多搜索次数',1)],['includeDomains','excludeDomains']),
  backend('openai','OpenAI','https://platform.openai.com/docs/guides/tools-web-search',[mode('key','https://api.openai.com/v1/responses','paid','Web search/tool charges plus model tokens; account terms apply.','搜索工具与模型 token 分别计费，以账户条款为准。','https://openai.com/api/pricing/')],[option('model','Model','模型','gpt-4.1'),option('maxOutputTokens','Maximum output tokens','最大输出 tokens',2048)]),
  backend('zhihu-web','Zhihu global search','https://developer.zhihu.com/docs?key=global_search',[mode('key','https://developer.zhihu.com/api/v1/content/global_search','allowance','Limited-time daily free allowance shown in account console; then ¥5/1,000. Resets at 00:00 Asia/Shanghai.','限时每日额度以控制台为准，其后 ¥5/千次；北京时间零点重置。','https://developer.zhihu.com/docs?key=billing_price')],[option('SearchDB','Search database','搜索数据库','all',['all','realtime','static']),option('Filter','Native filter expression','原生筛选表达式','')]),
  backend('zhihu-site','Zhihu site search','https://developer.zhihu.com/docs?key=zhihu_search',[mode('key','https://developer.zhihu.com/api/v1/content/zhihu_search','allowance','Limited-time daily allowance shown in account console; then ¥20/1,000. Shared across account secrets.','限时每日额度以控制台为准，其后 ¥20/千次；同账户密钥共享额度。','https://developer.zhihu.com/docs?key=billing_price')]),
  backend('deepseek','DeepSeek','https://api-docs.deepseek.com/guides/search/',[mode('key','https://api.deepseek.com/v1/tools/search','paid','$0.75/1,000 successful nonempty requests; 100 QPS/account.','$0.75/千次成功且非空请求；每账户 100 QPS。','https://api-docs.deepseek.com/guides/search/')],[option('need_content','Retrieve content','获取正文',false)]),
  backend('you','You.com','https://you.com/docs/api-reference/search/v1-search.md',[mode('anonymous','https://api.you.com/mcp','free','Free MCP profile: 100 queries/day; shared rate limits may apply.','免费 MCP profile：100 次/天，可能存在共享限流。','https://you.com/docs/agents/mcp-server.md'),mode('key','https://ydc-index.io/v1/search','paid','$5/1,000 searches; optional full-page retrieval costs extra.','$5/千次搜索；可选全文获取另外计费。','https://you.com/docs/administration/billing.md')],[],['language','region','recency'],'documented','live'),
  backend('baidu','Baidu Qianfan','https://cloud.baidu.cn/doc/qianfan/s/nmweljpt3',[mode('key','https://qianfan.baidubce.com/v2/ai_search/web_search','allowance','1,500/month free, default 3 QPS; domestic standard ¥0.036/request, higher editions cost more.','每月 1500 次免费，默认 3 QPS；国内 standard ¥0.036/次，更高版本价格更高。','https://cloud.baidu.cn/doc/qianfan/s/nmweljpt3')],[option('edition','Edition','版本','standard',['standard','enhanced','flagship'])]),
  backend('doubao','Volcengine Doubao','https://docs.volcengine.com/docs/networked-search/networked-search?lang=zh',[mode('key','https://open.feedcoopapi.com/search_api/web_search','allowance','500/month shared free allowance, 10 QPS; usage-based web ¥0.020/request. Subscription keys have independent limits.','每月共享 500 次免费，10 QPS；按量 web ¥0.020/次；订阅 Key 有独立限制。','https://docs.volcengine.com/docs/networked-search/online-search-product-billing?lang=zh')],[option('queryRewrite','Provider query rewrite','供应商改写查询',false)]),
  backend('open-websearch','open-websearch','https://github.com/Aas-ee/open-webSearch',[mode('anonymous','http://127.0.0.1:3210/search','self-hosted','Self-hosted daemon; no guaranteed quota, engine blocking and infrastructure costs apply. Project personal-use restrictions apply.','自建 daemon，无保证额度；有引擎限流及运行成本，注意项目个人使用限制。','https://github.com/Aas-ee/open-webSearch')],[option('engine','Fixed upstream engine','固定上游引擎','duckduckgo'),option('searchMode','Request strategy','请求方式','request',['request','playwright'])]),
  backend('serpex','Serpex','https://serpex.dev/docs/api/search',[mode('key','https://api.serpex.dev/api/search','trial','200 one-time credits; paid top-ups start around $0.80/1,000. Vendor routes internally; no fixed upstream engine.','一次性 200 credits；充值约 $0.80/千次起；供应商内部路由，不能固定其上游引擎。','https://serpex.dev/docs/getting-started/pricing')]),
  backend('x','X (Twitter)','https://docs.x.com/x-api/posts/search/quickstart/recent-search',[mode('session','https://x.com/i/api/graphql','account','Uses the browser session cookies (auth_token, ct0) of your own X account. No fee, but X changes its request signing and query ids regularly, so this mode can break until the adapter is updated.','使用你自己 X 账号的网页 cookie（auth_token、ct0）。不产生费用，但 X 会不定期改动前端签名与 queryId，失效后需要维护者更新适配器。','https://github.com/bestnite/x-mcp',{en:'{"authToken":"...","ct0":"..."}, or paste auth_token=...; ct0=... straight from DevTools',zh:'{"authToken":"...","ct0":"..."}，也可以直接粘贴浏览器里的 auth_token=...; ct0=...'}),mode('key','https://api.x.com/2/tweets/search/recent','paid','Official API with an app-only bearer token as the key. Pay per post read: about $0.005 each, so a 10-result search costs roughly $0.05. Recent search covers the last 7 days; reads are capped by the posts-per-search option.','官方 API，密钥填 app-only bearer token。按读取帖数计费：约 $0.005/条，取 10 条约 $0.05。近期搜索只覆盖最近 7 天，读取条数受「每次搜索帖数」参数限制。','https://docs.x.com/x-api/getting-started/pricing',{en:'{"bearerToken":"<app-only bearer token>"}',zh:'{"bearerToken":"<app-only bearer 令牌>"}'})],[option('postsPerSearch','Posts read per search','每次搜索读取帖数',10)],['recency']),
  backend('reddit','Reddit','https://github.com/reddit-archive/reddit/wiki/API',[mode('anonymous','https://gql-fed.reddit.com/','free','No credentials. Uses the Reddit Android app endpoint, because the public REST search and comments endpoints answer 403 to anonymous tokens since 2026-10. No published quota; shared rate limits.','无需凭证。走 Reddit 安卓客户端端点——自 2026-10 起公开 REST 的搜索与评论对匿名 token 一律返回 403。额度未公布，属共享限流。','https://github.com/bestnite/reddit-readonly-mcp'),mode('oauth','https://oauth.reddit.com/search','allowance','Official OAuth API: about 100 queries/minute per client for non-commercial use. client_credentials reads public data; add a username and password for a script grant.','官方 OAuth API：非商业用途约每客户端 100 次/分钟。client_credentials 即可读公开数据；补用户名密码则用 script 授权。','https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki',{en:'{"clientId":"...","clientSecret":"..."}; add "username" and "password" for a script grant',zh:'{"clientId":"...","clientSecret":"..."}；需要脚本授权就再加 "username" 与 "password"'})],[option('sort','Sort','排序','relevance',['relevance','hot','top','new','comments']),option('time','Time window','时间范围','all',['all','hour','day','week','month','year']),option('subreddit','Limit to subreddit','限定版块','')],['recency']),
  backend('xiaohongshu','Xiaohongshu','https://git.nite07.com/nite/search/src/branch/main/packages/core/image',[mode('browser','ws://127.0.0.1:3000/ws','self-hosted','Reads run through a browser you host, so nothing is billed per call and no public quota applies. The browser must be signed in to Xiaohongshu; this project ships an image that provides that browser, a VNC login surface and a token-protected endpoint.','读取走你自己托管的浏览器，不按次计费、无公开额度。浏览器需要处于小红书登录状态；本项目提供一个镜像，内含浏览器、VNC 登录界面和带令牌的端点。','https://git.nite07.com/nite/search/src/branch/main/packages/core/image',{en:'Bearer token printed by the browser container at startup. Set it once in the shared browser settings; it protects the browser endpoint, not a site account',zh:'浏览器容器启动时打印的 Bearer 令牌。在共享浏览器设置中填写一次即可；它保护浏览器端点，不是网站账户凭证'})],[option('sort','Sort','排序','general',['general','time_descending','popularity_descending']),{key:'statePath',type:'string',label:text('Session state file','会话状态文件'),help:text('Where the signed-in session is read from. Leave empty to use the core default (~/.config/dsh-search/browser/state.json), which has to be the file the browser container writes.','登录态从哪个文件读取。留空则用核心默认位置（~/.config/dsh-search/browser/state.json），它必须和浏览器容器写出的文件是同一个。'),default:''}],[],'documented','live'),
  backend('tencent-wsa','Tencent Cloud WSA','https://cloud.tencent.com/document/product/1806/121811',[mode('key','https://wsa.tencentcloudapi.com/','paid','¥14/¥20/¥26 per 1,000 by tier. Store a JSON credential {secretId,secretKey}; no free allowance verified.','分档 ¥14／¥20／¥26 每千次。凭证填写 JSON {secretId,secretKey}；免费额度未核实。','https://cloud.tencent.com/product/wsa',{en:'{"secretId":"...","secretKey":"..."}',zh:'{"secretId":"...","secretKey":"..."}'})],[{...option('Mode','Search mode','搜索模式',0),min:0,max:2}]),
];
export const backendById = (id: string): BackendDefinition | undefined => catalog.find(item => item.id === id);

/**
 * Fetch operations, declared for providers whose contract was established from official documentation.
 *
 * The metadata is a capability statement, not a user toggle: a provider without this entry can never
 * be selected for a page fetch, and its search behaviour is untouched. An access mode carries its own
 * transport, endpoint, evidence and cost, because one provider can fetch keylessly over MCP and with
 * a key over a REST API, and because a free keyless fetch and a billed keyed fetch are different
 * operations even on the same endpoint.
 *
 * `serves` is what the operation really returns: a Markdown-only or plain-text operation cannot
 * serve page HTML, which the engine records as an `unsupported-format` skip before any request is
 * sent. A provider that can return the page's own HTML says so, and its adapter really returns that
 * HTML for the requested format. See docs/PAGE-FETCH-PROVIDERS.md.
 */
const fetchOption = (key: string, type: OptionField['type'], label: string, zh: string, value: string | number | boolean, help: string, helpZh: string, bounds: { min?: number; max?: number; choices?: string[] } = {}): OptionField => ({ key, type, label: text(label, zh), help: text(help, helpZh), default: value, ...bounds });

/** The documented REST endpoint of Exa's Contents operation; its search endpoint is a different URL. */
const EXA_CONTENTS_ENDPOINT = 'https://api.exa.ai/contents';

/**
 * The documented REST endpoint of Parallel's Extract operation. The GA path is `/v1/extract`: the
 * provider's own documentation says `/v1beta/extract` is for existing integrations only, and the two
 * differ in request shape (`full_content` moved inside `advanced_settings`).
 */
const PARALLEL_EXTRACT_ENDPOINT = 'https://api.parallel.ai/v1/extract';

const DEEPSEEK_FETCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/fetch';
const SERPEX_CRAWL_ENDPOINT = 'https://api.serpex.dev/api/crawl';
const LINKUP_FETCH_ENDPOINT = 'https://api.linkup.so/v1/fetch';
const TAVILY_EXTRACT_ENDPOINT = 'https://api.tavily.com/extract';
const YOU_EXTRACT_ENDPOINT = 'https://ydc-index.io/v1/extract';
const KEENABLE_FETCH_ENDPOINT = 'https://api.keenable.ai/v1/fetch';
const KEENABLE_FETCH_PUBLIC_ENDPOINT = 'https://api.keenable.ai/v1/fetch/public';
const ANYSEARCH_EXTRACT_ENDPOINT = 'https://api.anysearch.com/v1/extract';
const DOUBAO_FETCH_ENDPOINT = 'https://open.feedcoopapi.com/search_api/fetch';
const OPEN_WEBSEARCH_FETCH_ENDPOINT = 'http://127.0.0.1:3210/fetch-web';

const exaFetch: FetchOperationDefinition = {
  tool: 'web_fetch_exa',
  modes: ['anonymous', 'key'],
  // Keyless access is the MCP tool; a stored key uses the documented REST API instead of asking the
  // keyless broker to fetch on the account's behalf.
  transport: { key: 'rest' },
  endpoints: { key: EXA_CONTENTS_ENDPOINT },
  evidence: {
    key: {
      evidence: 'documented',
      verifiedAt: '2026-11-18',
      source: 'https://github.com/exa-labs/openapi-spec/blob/master/exa-openapi-spec.yaml',
      notes: text(
        'Implemented from the official OpenAPI spec (POST /contents, x-api-key). No call with a real API key was made from this deployment, so this mode is documented only, not live-verified.',
        '依据官方 OpenAPI 规范实现（POST /contents，x-api-key）。本部署没有用真实 API Key 发起过调用，因此该模式只有文档核实，没有实测。',
      ),
    },
  },
  modeConstraints: {
    anonymous: {
      limits: text('Free keyless MCP, no account; the rate limit is not published. One call fetches one URL.', '无 Key 的免费 MCP，无需账号；限流未公布。一次调用抓取一个 URL。'),
      pricingUrl: 'https://exa.ai/pricing',
    },
    key: {
      limits: text('$1 per 1,000 pages for text contents; a keyed call is billed by the account balance.', '正文按 $1/千页计费；有 Key 调用计入账户余额。'),
      pricingUrl: 'https://exa.ai/products/contents',
    },
  },
  serves: ['markdown'],
  options: [fetchOption('maxCharacters', 'number', 'Characters per page', '每页字符上限', 50000, 'Characters the provider may return per page. Its own default is 3000; a page fetch asks for more because the page itself is the result.', '供应商每页最多返回的字符数。其默认值是 3000；页面抓取要的是整页内容，所以这里请求更多。')],
  docs: 'https://exa.ai/docs/get-started/exa-mcp',
  verifiedAt: '2026-11-18',
  notes: text('Returns native Markdown. The keyless MCP mode reports no page title and no target HTTP status; the keyed REST mode reports both. Markdown only: HTML is skipped before any request.', '返回原生 Markdown。无 Key 的 MCP 模式不提供页面标题与目标 HTTP 状态码；有 Key 的 REST 模式两者都会返回。仅支持 Markdown：请求 HTML 时不会发出请求而是直接跳过。'),
};

const parallelFetch: FetchOperationDefinition = {
  tool: 'web_fetch',
  modes: ['anonymous', 'key'],
  // The keyless mode is the MCP tool; a stored key uses the documented REST Extract operation.
  transport: { key: 'rest' },
  endpoints: { key: PARALLEL_EXTRACT_ENDPOINT },
  evidence: {
    key: {
      evidence: 'documented',
      verifiedAt: '2026-11-18',
      source: 'https://docs.parallel.ai/api-reference/extract/extract.md',
      notes: text(
        'Implemented from the official Extract API reference (POST /v1/extract, x-api-key, full_content inside advanced_settings). No call with a real API key was made from this deployment, so this mode is documented only, not live-verified.',
        '依据官方 Extract API 参考实现（POST /v1/extract，x-api-key，full_content 位于 advanced_settings 内）。本部署没有用真实 API Key 发起过调用，因此该模式只有文档核实，没有实测。',
      ),
    },
  },
  modeConstraints: {
    anonymous: {
      limits: text('Free anonymous MCP, no account; the numeric quota is not published.', '免费匿名 MCP，无需账号；数值额度未公布。'),
      pricingUrl: 'https://parallel.ai/pricing',
    },
    key: {
      limits: text('$1 per 1,000 URLs on the Extract API.', 'Extract API 按 $1/千个 URL 计费。'),
      pricingUrl: 'https://docs.parallel.ai/getting-started/pricing',
    },
  },
  serves: ['markdown'],
  options: [fetchOption('full_content', 'boolean', 'Full page content', '返回整页正文', true, 'Ask for the complete page rather than objective-focused excerpts. Excerpt mode is cheaper but is not the page.', '请求完整页面，而不是按目标筛选的摘要。摘要模式更省，但不是整页。')],
  docs: 'https://docs.parallel.ai/integrations/mcp/quickstart',
  verifiedAt: '2026-11-18',
  notes: text('Returns native Markdown with a page title. Target status is reported only when the target itself failed, in both modes. Markdown only: HTML is skipped before any request.', '返回原生 Markdown 与页面标题。两种模式下，只有目标页面失败时才报告目标状态码。仅支持 Markdown：请求 HTML 时不会发出请求而是直接跳过。'),
};

const deepseekFetch: FetchOperationDefinition = {
  modes: ['key'],
  // This provider's fetch is a documented REST operation and nothing else: there is no MCP tool.
  transport: { key: 'rest' },
  endpoints: { key: DEEPSEEK_FETCH_ENDPOINT },
  evidence: {
    key: {
      evidence: 'documented',
      verifiedAt: '2026-11-18',
      source: 'https://api-docs.deepseek.com/guides/search/',
      notes: text(
        'Implemented from the official Search & Fetch guide and Fetch API reference (POST /v1/tools/fetch, Bearer key, body {url}, response {title, content}). No call with a real API key was made from this deployment, so this mode is documented only.',
        '依据官方 Search & Fetch 指南与 Fetch API 参考实现（POST /v1/tools/fetch，Bearer 密钥，请求 {url}，响应 {title, content}）。本部署没有用真实 API Key 发起过调用，因此该模式只有文档核实。',
      ),
    },
  },
  modeConstraints: {
    key: {
      limits: text('$0.75 per 1,000 successful fetch requests; 25 QPS per account for fetch plus a per-domain limit. A failed request is not billed.', '按 $0.75/千次成功抓取计费；抓取每账户 25 QPS，另有单域名限流。失败的请求不计费。'),
      pricingUrl: 'https://api-docs.deepseek.com/guides/search/',
    },
  },
  serves: ['markdown'],
  options: [],
  docs: 'https://api-docs.deepseek.com/guides/search/',
  verifiedAt: '2026-11-18',
  notes: text(
    'Returns native Markdown and a title, and no target status: its 404 means the fetch could not retrieve usable page content, which is the API answering, not the target. The title is empty when the page has none.',
    '返回原生 Markdown 与标题，不提供目标状态码：其 404 表示抓取未能取到可用正文，是接口自身的结果，并非目标网页的状态。页面没有标题时标题为空。',
  ),
};

const serpexFetch: FetchOperationDefinition = {
  modes: ['key'],
  transport: { key: 'rest' },
  endpoints: { key: SERPEX_CRAWL_ENDPOINT },
  evidence: {
    key: {
      evidence: 'documented',
      verifiedAt: '2026-11-18',
      source: 'https://serpex.dev/docs/api/extract',
      notes: text(
        'Implemented from the official Extract API reference (POST /api/crawl, Bearer sk_ key, urls plus format, results[].status_code as the target status). No call with a real API key was made from this deployment, so this mode is documented only.',
        '依据官方 Extract API 参考实现（POST /api/crawl，Bearer sk_ 密钥，urls 与 format，results[].status_code 为目标状态码）。本部署没有用真实 API Key 发起过调用，因此该模式只有文档核实。',
      ),
    },
  },
  modeConstraints: {
    key: {
      limits: text('1 credit per successfully extracted URL; the same organization repeating the same URL and format within 5 minutes is free. Failed extractions are never charged.', '每个成功抽取的 URL 计 1 credit；同一组织 5 分钟内对同一 URL 使用同一 format 不重复计费。失败的抽取不计费。'),
      pricingUrl: 'https://serpex.dev/docs/getting-started/pricing',
    },
  },
  serves: ['markdown', 'html'],
  options: [],
  docs: 'https://serpex.dev/docs/api/extract',
  verifiedAt: '2026-11-18',
  notes: text(
    'Format is chosen per request: markdown strips boilerplate, html returns the full rendered page HTML. results[].status_code is the target page status while the API itself answered 200, so the two are never folded together. No page title is returned.',
    '格式按请求选择：markdown 去掉导航等样板，html 返回整页渲染后的 HTML。results[].status_code 是目标网页状态，而接口本身返回 200，两者不会混在一起。不返回页面标题。',
  ),
};

const linkupFetch: FetchOperationDefinition = {
  modes: ['key'],
  transport: { key: 'rest' },
  endpoints: { key: LINKUP_FETCH_ENDPOINT },
  evidence: {
    key: {
      evidence: 'documented',
      verifiedAt: '2026-11-18',
      source: 'https://docs.linkup.so/pages/documentation/endpoints/fetch/reference.md',
      notes: text(
        'Implemented from the official /fetch OpenAPI reference and overview (POST /v1/fetch, Bearer key, response markdown plus optional rawContent/contentType). No call with a real API key was made from this deployment, so this mode is documented only.',
        '依据官方 /fetch OpenAPI 参考与概览实现（POST /v1/fetch，Bearer 密钥，响应 markdown 及可选的 rawContent/contentType）。本部署没有用真实 API Key 发起过调用，因此该模式只有文档核实。',
      ),
    },
  },
  modeConstraints: {
    key: {
      limits: text('$0.001 per call with the standard mode and no JavaScript rendering; $0.005 with JavaScript rendering or the pro mode. Structured output adds $0.001.', '标准模式且不渲染 JavaScript 时 $0.001/次；渲染 JavaScript 或使用 pro 模式时 $0.005/次；结构化输出另加 $0.001。'),
      pricingUrl: 'https://docs.linkup.so/pages/documentation/endpoints/fetch/overview.md',
    },
  },
  serves: ['markdown', 'html'],
  options: [
    fetchOption('mode', 'select', 'Fetch mode', '抓取模式', 'standard', 'standard retrieves regular pages; pro is documented to succeed more often on hard-to-retrieve pages and costs $0.005 per call.', 'standard 用于普通页面；pro 在难以抓取的页面上成功率更高，按 $0.005/次计费。', { choices: ['standard', 'pro'] }),
    fetchOption('renderJs', 'boolean', 'Render JavaScript', '渲染 JavaScript', false, 'Render the page JavaScript before extraction. Needed for client-side-rendered pages and billed at $0.005 per call.', '抽取前先执行页面 JavaScript。客户端渲染的页面需要它，按 $0.005/次计费。'),
  ],
  docs: 'https://docs.linkup.so/pages/documentation/endpoints/fetch/overview.md',
  verifiedAt: '2026-11-18',
  notes: text(
    'Always returns Markdown; page HTML comes back as rawContent only when the request asks for it, and contentType says what that content is, so a non-HTML body is never presented as the page HTML. No page title and no target status are returned.',
    '总是返回 Markdown；只有在请求要求时才回传 rawContent 作为页面 HTML，并由 contentType 说明该内容的类型，因此非 HTML 内容不会被当成页面 HTML。不返回页面标题与目标状态码。',
  ),
};

const tavilyFetch: FetchOperationDefinition = {
  modes: ['anonymous', 'key'],
  // Both modes are the same documented REST Extract operation; the keyless header selects the free
  // anonymous path. Adding this mode changes no search mode and no search request.
  transport: { anonymous: 'rest', key: 'rest' },
  endpoints: { anonymous: TAVILY_EXTRACT_ENDPOINT, key: TAVILY_EXTRACT_ENDPOINT },
  evidence: {
    anonymous: {
      evidence: 'live',
      verifiedAt: '2026-11-18',
      source: 'https://docs.tavily.com/documentation/keyless.md',
      notes: text(
        'Observed live from this checkout on 2026-11-18: POST https://api.tavily.com/extract with header X-Tavily-Access-Mode: keyless and no credential answered HTTP 200 with results[0] = {url, title, raw_content, images} and an empty failed_results. The published schema lists url and raw_content but not results[].title, which appeared in the live answer.',
        '本机于 2026-11-18 实测：带 X-Tavily-Access-Mode: keyless 头、不带任何凭证 POST https://api.tavily.com/extract，返回 HTTP 200，results[0] 含 {url, title, raw_content, images}，failed_results 为空。公开 schema 只列了 url 与 raw_content，没有 results[].title，该字段出现在实测响应中。',
      ),
    },
    key: {
      evidence: 'documented',
      verifiedAt: '2026-11-18',
      source: 'https://docs.tavily.com/documentation/api-reference/endpoint/extract.md',
      notes: text(
        'Implemented from the official Extract OpenAPI reference (POST /extract, Bearer key, urls plus format and extract_depth). No call with a real API key was made from this deployment, so this mode is documented only.',
        '依据官方 Extract OpenAPI 参考实现（POST /extract，Bearer 密钥，urls 与 format、extract_depth）。本部署没有用真实 API Key 发起过调用，因此该模式只有文档核实。',
      ),
    },
  },
  modeConstraints: {
    anonymous: {
      limits: text('Free keyless access on the same endpoint, rate-limited; the numeric limit is not published. No account and no credit.', '同一端点上的免费无 Key 访问，有限流但未公布数值。无需账号、不消耗 credit。'),
      pricingUrl: 'https://docs.tavily.com/documentation/keyless.md',
    },
    key: {
      limits: text('1,000 free credits/month; basic extraction is 1 credit per 5 successful URLs, advanced 2 credits per 5. Pay-as-you-go is $0.008/credit.', '每月免费 1000 credits；basic 抽取每 5 个成功 URL 计 1 credit，advanced 每 5 个计 2 credits；按量 $0.008/credit。'),
      pricingUrl: 'https://docs.tavily.com/documentation/api-credits',
    },
  },
  serves: ['markdown'],
  options: [
    fetchOption('format', 'select', 'Extracted format', '抽取格式', 'markdown', 'markdown returns page content as Markdown; text returns plain text and is documented to be slower.', 'markdown 返回 Markdown 正文；text 返回纯文本，文档说明其更慢。', { choices: ['markdown', 'text'] }),
    fetchOption('extract_depth', 'select', 'Extraction depth', '抽取深度', 'basic', 'advanced retrieves more data including tables and embedded content at 2 credits per 5 URLs; basic is 1 credit per 5.', 'advanced 会取更多内容（含表格与嵌入内容），每 5 个 URL 计 2 credits；basic 每 5 个计 1 credit。', { choices: ['basic', 'advanced'] }),
  ],
  docs: 'https://docs.tavily.com/documentation/keyless.md',
  verifiedAt: '2026-11-18',
  notes: text(
    'Returns the page content and no target status; a URL the provider could not process is reported as a provider failure, and its error text is never echoed. Keyless responses are documented to use the same schema as keyed ones. Adding keyless fetching changes no search behaviour.',
    '返回页面正文，不提供目标状态码；无法处理的 URL 会作为供应商失败报告，其错误文本不会被回显。文档说明无 Key 响应与有 Key 响应使用同一 schema。新增无 Key 抓取不改变任何搜索行为。',
  ),
};

const youFetch: FetchOperationDefinition = {
  // Fetch is keyed only: the documented Extract operation is the keyed REST API. The keyless MCP
  // server answered an anonymous client with an authentication error, so no keyless fetch is offered.
  modes: ['key'],
  transport: { key: 'rest' },
  endpoints: { key: YOU_EXTRACT_ENDPOINT },
  evidence: {
    key: {
      evidence: 'documented',
      verifiedAt: '2026-11-18',
      source: 'https://you.com/docs/api-reference/extract.md',
      notes: text(
        'Implemented from the official Extract API reference (POST /v1/extract, X-API-Key, url plus full_page.extraction_formats). The Contents API is deprecated and is not used. No call with a real API key was made from this deployment, so this mode is documented only.',
        '依据官方 Extract API 参考实现（POST /v1/extract，X-API-Key，url 与 full_page.extraction_formats）。Contents API 已弃用，未使用。本部署没有用真实 API Key 发起过调用，因此该模式只有文档核实。',
      ),
    },
  },
  modeConstraints: {
    key: {
      limits: text('$0.90 per 1,000 URLs. PDFs parsed with the default standard effort add $0.50 per 1,000 PDF pages; lite adds none.', '每 1000 个 URL 计 $0.90。PDF 使用默认 standard 解析时每 1000 页另加 $0.50；lite 不另计。'),
      pricingUrl: 'https://you.com/docs/administration/billing',
    },
  },
  serves: ['markdown', 'html'],
  options: [],
  docs: 'https://you.com/docs/api-reference/extract.md',
  verifiedAt: '2026-11-18',
  notes: text(
    'Returns a title and the requested formats under contents.full_page, and no target status. Requesting html asks for the page HTML and returns that HTML; Markdown is not converted into it.',
    '返回标题与 contents.full_page 下所请求的格式，不提供目标状态码。请求 html 时会向供应商要求页面 HTML 并原样返回；不会用 Markdown 拼出 HTML。',
  ),
};

const keenableFetch: FetchOperationDefinition = {
  modes: ['anonymous', 'key'],
  // Both fetch modes are the documented GET operation; the public path takes the application title
  // header instead of a key, exactly as the keyless search mode does.
  transport: { anonymous: 'rest', key: 'rest' },
  endpoints: { anonymous: KEENABLE_FETCH_PUBLIC_ENDPOINT, key: KEENABLE_FETCH_ENDPOINT },
  evidence: {
    anonymous: {
      evidence: 'live',
      verifiedAt: '2026-11-18',
      source: 'https://docs.keenable.ai/api-reference/fetch.md',
      notes: text(
        'Observed live from this checkout on 2026-11-18: GET https://api.keenable.ai/v1/fetch/public?url=https://example.com with header X-Keenable-Title answered HTTP 200 with {url, title, content, description, truncated, total_chars} and x-ratelimit-limit: 1000.',
        '本机于 2026-11-18 实测：带 X-Keenable-Title 头 GET https://api.keenable.ai/v1/fetch/public?url=https://example.com，返回 HTTP 200，响应为 {url, title, content, description, truncated, total_chars}，限流头 x-ratelimit-limit 为 1000。',
      ),
    },
    key: {
      evidence: 'documented',
      verifiedAt: '2026-11-18',
      source: 'https://docs.keenable.ai/api-reference/fetch.md',
      notes: text(
        'Implemented from the official Fetch reference (GET /v1/fetch, X-API-Key, query url and max_chars and live). No call with a real API key was made from this deployment, so this mode is documented only.',
        '依据官方 Fetch 参考实现（GET /v1/fetch，X-API-Key，查询参数 url、max_chars、live）。本部署没有用真实 API Key 发起过调用，因此该模式只有文档核实。',
      ),
    },
  },
  modeConstraints: {
    anonymous: {
      limits: text('1,000 requests/hour and 10/second per IP and endpoint, no credits; the public title header is required.', '每 IP 与端点 1000 次/小时、10 次/秒，不消耗 credit；必须发送公开调用标识头。'),
      pricingUrl: 'https://docs.keenable.ai/pricing.md',
    },
    key: {
      limits: text('100,000 fetches/month free with a key; a fetch the provider had to crawl live is billed as the fetch.live SKU. Confirm current account terms.', '有 Key 时每月 10 万次抓取免费；供应商需要实时抓取的请求按 fetch.live 计费。以账户当前条款为准。'),
      pricingUrl: 'https://docs.keenable.ai/pricing.md',
    },
  },
  serves: ['markdown'],
  options: [
    fetchOption('clientTitle', 'string', 'Application title', '调用方名称', 'dsh-search', 'Sent as X-Keenable-Title on the public fetch path, which requires an application name. The keyed path ignores it.', '在公开抓取路径上作为 X-Keenable-Title 发送，该路径要求调用方名称；有 Key 的路径不使用它。'),
    fetchOption('max_chars', 'number', 'Characters per page', '每页字符上限', 50000, 'Hard cap on the returned content. The response says when it truncated, and the note reports that.', '返回正文的硬上限。被截断时响应会标明，抓取记录里会说明。', { min: 1, max: 1000000 }),
    fetchOption('live', 'boolean', 'Fetch live', '实时抓取', false, 'Fetch the page from the source now instead of returning the indexed copy when one exists.', '直接从源站抓取，而不是在存在索引副本时返回副本。'),
  ],
  docs: 'https://docs.keenable.ai/api-reference/fetch.md',
  verifiedAt: '2026-11-18',
  notes: text(
    'Returns native Markdown, a title, the final URL after redirects, and author/published_at/truncated metadata; it reports no target HTTP status. Markdown only: HTML is skipped before any request.',
    '返回原生 Markdown、标题、重定向后的最终地址，以及 author/published_at/truncated 元数据；不提供目标 HTTP 状态码。仅支持 Markdown：请求 HTML 时不会发出请求而是直接跳过。',
  ),
};

const anysearchFetch: FetchOperationDefinition = {
  modes: ['anonymous', 'key'],
  transport: { anonymous: 'rest', key: 'rest' },
  endpoints: { anonymous: ANYSEARCH_EXTRACT_ENDPOINT, key: ANYSEARCH_EXTRACT_ENDPOINT },
  evidence: {
    anonymous: {
      evidence: 'live',
      verifiedAt: '2026-11-18',
      source: 'https://www.anysearch.com/docs/api-endpoints/v1-extract.md',
      notes: text(
        'Observed live from this checkout on 2026-11-18: POST https://api.anysearch.com/v1/extract with no credential answered HTTP 200 with {code: 0, message: "success", request_id, data: {url, title, content}} and anonymous rate-limit headers.',
        '本机于 2026-11-18 实测：不带任何凭证 POST https://api.anysearch.com/v1/extract，返回 HTTP 200，响应为 {code: 0, message: "success", request_id, data: {url, title, content}}，并带匿名限流头。',
      ),
    },
    key: {
      evidence: 'documented',
      verifiedAt: '2026-11-18',
      source: 'https://www.anysearch.com/docs/api-endpoints/v1-extract.md',
      notes: text(
        'Implemented from the official Extract reference (POST /v1/extract, Bearer key, body {url}) with a live anonymous observation of the same document. No call with a real API key was made from this deployment, so this mode is documented only.',
        '依据官方 Extract 参考实现（POST /v1/extract，Bearer 密钥，请求 {url}），并对同一响应结构做了匿名实测。本部署没有用真实 API Key 发起过调用，因此该模式只有文档核实。',
      ),
    },
  },
  modeConstraints: {
    anonymous: {
      limits: text('Anonymous requests are metered per IP with lower limits and a daily free reset (UTC). No credential is created automatically by this plugin.', '匿名请求按 IP 计量、限流更低，每日（UTC）重置。本插件不会自动创建任何凭证。'),
      pricingUrl: 'https://anysearch.com/pricing.md',
    },
    key: {
      limits: text('Free plan 1,000/day, 10 QPS; Pro calls are billed separately.', '免费档 1000 次/天、10 QPS；Pro 调用另行计费。'),
      pricingUrl: 'https://anysearch.com/pricing.md',
    },
  },
  serves: ['markdown'],
  // Cleaned text with no format choice: it is labelled text, never page HTML and never native Markdown.
  options: [],
  docs: 'https://www.anysearch.com/docs/api-endpoints/v1-extract.md',
  verifiedAt: '2026-11-18',
  notes: text(
    'Returns a title and cleaned page text with no format parameter, capped by the provider at 50,000 characters with no truncation flag; it reports no target status. The text is returned as text, not relabelled as Markdown or HTML.',
    '返回标题与清洗后的页面文本，没有格式参数，供应商最多返回 50000 字符且没有截断标记；不提供目标状态码。文本按文本返回，不会改标为 Markdown 或 HTML。',
  ),
};

const doubaoFetch: FetchOperationDefinition = {
  modes: ['key'],
  transport: { key: 'rest' },
  endpoints: { key: DOUBAO_FETCH_ENDPOINT },
  evidence: {
    key: {
      evidence: 'documented',
      verifiedAt: '2026-11-18',
      source: 'https://docs.volcengine.com/docs/zh/networked-search/doubao-search-web-analysis-fetch.md',
      notes: text(
        'Implemented from the official Fetch (网页解析) reference: POST /search_api/fetch with a Bearer key, body {Url}, response Result.Data with StatusCode, Title, PublishTime, RedirectedUrl and ContentText. No call with a real API key was made from this deployment, so this mode is documented only.',
        '依据官方 Fetch（网页解析）参考实现：POST /search_api/fetch，Bearer 密钥，请求 {Url}，响应 Result.Data 含 StatusCode、Title、PublishTime、RedirectedUrl、ContentText。本部署没有用真实 API Key 发起过调用，因此该模式只有文档核实。',
      ),
    },
  },
  modeConstraints: {
    key: {
      limits: text('Pay-as-you-go API keys only: subscription-plan keys work for search but cannot fetch. Each fetch uses 1 call of the 500/month free allowance shared with Doubao search, then ¥0.003 per call.', '仅支持按量后付费 API Key：订阅套餐 Key 可用于搜索，但无法调用 Fetch。每次抓取占用与豆包搜索共享的每月 500 次免费额度中的 1 次，之后按 ¥0.003/次计费。'),
      pricingUrl: 'https://docs.volcengine.com/docs/zh/networked-search/online-search-product-billing',
    },
  },
  serves: ['markdown'],
  // Plain text only, up to 50,000 characters; it is labelled text, never page HTML.
  options: [],
  docs: 'https://docs.volcengine.com/docs/zh/networked-search/doubao-search-web-analysis-fetch.md',
  verifiedAt: '2026-11-18',
  notes: text(
    'Returns a title, plain text up to 50,000 characters and the target page status in Result.Data.StatusCode, which is separate from an API error in ResponseMetadata.Error. Only pay-as-you-go API keys can fetch: a subscription-plan key fails with 10409, and this plugin cannot tell the two key types apart before the call. Static HTML only, no JavaScript execution; HTML is skipped before any request because the operation returns text.',
    '返回标题、最多 50000 字符的纯文本，以及 Result.Data.StatusCode 中的目标网页状态码，它与 ResponseMetadata.Error 里的接口错误分开处理。只有按量后付费 API Key 能调用 Fetch：订阅套餐 Key 会返回 10409，而本插件无法在调用前区分这两种 Key。仅解析静态 HTML、不执行 JavaScript；该操作返回文本，所以请求 HTML 时不会发出请求而是直接跳过。',
  ),
};

const openWebsearchFetch: FetchOperationDefinition = {
  modes: ['anonymous'],
  transport: { anonymous: 'rest' },
  endpoints: { anonymous: OPEN_WEBSEARCH_FETCH_ENDPOINT },
  evidence: {
    anonymous: {
      evidence: 'documented',
      verifiedAt: '2026-11-18',
      source: 'https://raw.githubusercontent.com/Aas-ee/open-webSearch/main/docs/http-api.md',
      notes: text(
        'Implemented from the project\'s documented local daemon HTTP API (POST /fetch-web with url, maxChars, renderMode). No daemon answered 127.0.0.1:3210 during this run, so this mode was not exercised live; it is documented only.',
        '依据该项目公开的本地 daemon HTTP API 文档实现（POST /fetch-web，参数 url、maxChars、renderMode）。本次运行期间 127.0.0.1:3210 没有 daemon 响应，因此该模式没有实测，只有文档核实。',
      ),
    },
  },
  modeConstraints: {
    anonymous: {
      limits: text('Self-hosted daemon: no vendor fee and no published quota; the daemon\'s own rate limits and your infrastructure costs apply.', '自建 daemon：无厂商调用费，也没有公开额度；实际受 daemon 自身限流与你的运行成本约束。'),
      pricingUrl: 'https://github.com/Aas-ee/open-webSearch',
    },
  },
  serves: ['markdown'],
  // The daemon returns extracted page text; it is labelled text, never page HTML.
  options: [
    fetchOption('maxChars', 'number', 'Characters per page', '每页字符上限', 30000, 'Maximum returned content length the daemon accepts: 1,000 to 200,000.', 'daemon 允许返回的最大内容长度：1000 到 200000。', { min: 1000, max: 200000 }),
    fetchOption('renderMode', 'select', 'Render mode', '抓取方式', 'auto', 'request uses HTTP only, auto adds browser fallback when the daemon has one, browser renders directly and needs a working Playwright target.', 'request 仅用 HTTP；auto 在 daemon 具备浏览器能力时回退；browser 直接渲染，需要可用的 Playwright 目标。', { choices: ['request', 'auto', 'browser'] }),
  ],
  docs: 'https://raw.githubusercontent.com/Aas-ee/open-webSearch/main/docs/http-api.md',
  verifiedAt: '2026-11-18',
  notes: text(
    'Returns extracted page text and a title that may be empty, with no target status. The endpoint is the daemon\'s own address from its configuration, so it is unreachable unless that daemon is running; the crawler may also need a browser target for hard pages.',
    '返回抽取后的页面文本与可能为空的标题，不提供目标状态码。端点是该 daemon 自身配置的地址，未运行该 daemon 时不可达；难以抓取的页面也可能需要浏览器目标。',
  ),
};

const fetchOperations: Record<string, FetchOperationDefinition> = {
  exa: exaFetch,
  parallel: parallelFetch,
  deepseek: deepseekFetch,
  serpex: serpexFetch,
  linkup: linkupFetch,
  tavily: tavilyFetch,
  you: youFetch,
  keenable: keenableFetch,
  anysearch: anysearchFetch,
  doubao: doubaoFetch,
  'open-websearch': openWebsearchFetch,
};

for (const definition of catalog) {
  const operation = fetchOperations[definition.id];
  if (!operation) continue;
  definition.fetch = operation;
  // The verified fetch endpoint of an access mode is declared by the operation itself, never derived
  // from the search endpoint by string rewriting: searching and fetching are different operations.
  for (const mode of definition.modes) {
    if (!operation.modes.includes(mode.mode)) continue;
    mode.fetchEndpoint = operation.endpoints?.[mode.mode] ?? mode.endpoint;
  }
}
