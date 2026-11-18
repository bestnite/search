import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendCredentialRef, defaultConfig, parseConfig, validateConfig } from '../src/config.js';
import { catalog } from '../src/catalog.js';
import { createPageFetchEngine } from '../src/fetch/engine.js';
import { callProviderTool, fetchFromProvider, type ProviderRouteRequest } from '../src/fetch/provider.js';
import type { AccessMode, SearchConfig } from '../src/types.js';
import type { FetchFormat } from '../src/fetch/types.js';

/**
 * Contract tests for every fetch provider added in this batch.
 *
 * Each provider is driven through the injected fetcher, so no test here touches the network. The
 * request each adapter builds is asserted field by field against the provider's published contract,
 * and the answer is asserted to be passed through — native Markdown stays Markdown, a provider's own
 * HTML stays HTML, plain text is never relabelled — with the target status kept separate from the
 * provider API status. The two anonymous observations recorded in the catalog were made manually
 * against the live endpoints; they are not replayed here.
 */

interface Call { url: string; init: RequestInit }

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  return { fetcher, calls };
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

const publicResolver = async (): Promise<string[]> => ['93.184.216.34'];

const definitionOf = (providerId: string) => {
  const definition = catalog.find(item => item.id === providerId);
  assert.ok(definition?.fetch, `${providerId} declares a fetch operation`);
  return definition;
};

/** The request the engine builds for one provider mode, taken from the catalog itself. */
const requestFor = (providerId: string, mode: AccessMode, fetcher: typeof fetch, overrides: Partial<ProviderRouteRequest> = {}): ProviderRouteRequest => {
  const definition = definitionOf(providerId);
  const operation = definition.fetch!;
  const endpoint = operation.endpoints?.[mode];
  assert.ok(endpoint, `${providerId}: the ${mode} mode declares its fetch endpoint`);
  return {
    providerId,
    url: 'https://example.com/page',
    format: 'markdown',
    transport: operation.transport?.[mode] ?? 'mcp',
    endpoint,
    tool: operation.tool ?? '',
    mode,
    options: Object.fromEntries(operation.options.map(option => [option.key, option.default])),
    routeTimeoutMs: 5_000,
    signal: new AbortController().signal,
    maxChars: 1_000_000,
    ...(mode === 'anonymous' ? {} : { credential: 'stored-provider-key' }),
    fetcher,
    ...overrides,
  };
};

const headersOf = (call: Call): Record<string, string> => call.init.headers as Record<string, string>;
const bodyOf = (call: Call): Record<string, unknown> => JSON.parse(String(call.init.body)) as Record<string, unknown>;
const queryOf = (call: Call): URLSearchParams => new URL(call.url).searchParams;

/** The documented answer of each provider, in the shape its own contract publishes. */
const fixtures = {
  deepseek: () => ({ title: 'Example article', content: '# Example article\n\nArticle content.' }),
  serpex: () => ({
    success: true,
    results: [{ url: 'https://example.com/final', success: true, markdown: '# Example\n\nnative markdown', html: '<!doctype html><html><body><p>native html</p></body></html>', status_code: 200 }],
    metadata: { total_urls: 1, processed_urls: 1, successful_crawls: 1, credits_used: 1 },
  }),
  linkup: () => ({ markdown: '# Linkup docs\n\nnative markdown', favicon: 'https://favicons.linkup.so?domain=example.com', rawContent: '<!doctype html><html><body><p>raw page</p></body></html>', contentType: 'html' }),
  tavily: () => ({ results: [{ url: 'https://example.com/final', title: 'Example Domain', raw_content: 'native extracted content', images: [] }], failed_results: [], response_time: 0.12, request_id: 'req_1' }),
  you: () => ({ url: 'https://example.com/final', extraction_source: 'blend', title: 'Example Page', contents: { full_page: { markdown: '# Example Page\n\nnative markdown', html: '<h1>Example Page</h1><p>native html</p>' } }, metadata: { site_name: 'Example' } }),
  keenable: () => ({ url: 'https://example.com/', title: 'Example Domain', content: 'native markdown from keenable', description: '', truncated: false, total_chars: 28 }),
  anysearch: () => ({ code: 0, message: 'success', request_id: 'req_1', data: { url: 'https://example.com/page', title: 'Example Article', content: 'cleaned page text' } }),
  doubao: () => ({
    ResponseMetadata: { RequestId: 'req_1', Action: 'Fetch', Version: '2025-01-01', Service: 'volc_torchlight_api', Region: 'cn-north-1' },
    Result: { Data: { StatusCode: 200, Url: 'https://example.com/page', RedirectedUrl: 'https://example.com/final', Title: '示例网页标题', PublishTime: 1_788_496_200, ContentText: 'plain page text' }, LogId: 'log_1' },
  }),
  'open-websearch': () => ({
    status: 'ok',
    data: { url: 'https://example.com/page', finalUrl: 'https://example.com/final', contentType: 'text/html; charset=utf-8', title: '', retrievalMethod: 'request', truncated: false, content: 'extracted page text' },
    error: null,
    hint: null,
  }),
} as const;

type ProviderId = keyof typeof fixtures;

/** The two providers that shipped before this batch, in the shape their keyed REST modes return. */
const preExistingFixtures = {
  exa: () => ({ requestId: 'req_1', results: [{ url: 'https://example.com/final', title: 'Example Page', text: '# Existing Markdown' }], statuses: [{ id: 'https://example.com/page', status: 'success' }] }),
  parallel: () => ({ extract_id: 'extract_1', results: [{ url: 'https://example.com/final', title: 'Example Page', full_content: '# Existing Markdown', excerpts: [] }], errors: [] }),
} as const;

// --- catalog metadata -------------------------------------------------------------------------

test('every fetch operation declares its transport, evidence and cost for each mode it offers', () => {
  const liveModes: string[] = [];
  for (const definition of catalog) {
    const operation = definition.fetch;
    if (!operation) continue;
    assert.ok(operation.modes.length > 0, `${definition.id}: at least one fetch mode`);
    for (const mode of operation.modes) {
      // A mode with no MCP adapter must not fall back to the MCP transport: the transport is declared.
      const transport = operation.transport?.[mode] ?? (operation.tool ? 'mcp' : undefined);
      assert.ok(transport, `${definition.id}/${mode}: the transport is declared or an MCP tool exists`);
      // The endpoint is declared either by the operation, or by the search mode's own verified fetch
      // endpoint when the fetch rides the same MCP endpoint the search mode uses.
      const endpoint = operation.endpoints?.[mode] ?? definition.modes.find(item => item.mode === mode)?.fetchEndpoint;
      assert.ok(endpoint, `${definition.id}/${mode}: the fetch endpoint is declared`);
      // The first fetch providers recorded their keyless modes implicitly (an absent entry shares the
      // operation's live date). Every mode added since states its own evidence, so nothing new can
      // inherit a live date it was never observed on.
      const evidence = operation.evidence?.[mode];
      if (!evidence) {
        assert.ok(['exa', 'parallel'].includes(definition.id), `${definition.id}/${mode}: only the pre-existing live modes may inherit their evidence`);
        assert.equal(definition.fetch!.verifiedAt, '2026-11-18');
        continue;
      }
      assert.match(evidence.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
      if (evidence.evidence === 'documented') {
        assert.ok(evidence.source, `${definition.id}/${mode}: a documented mode names where its contract was read`);
        assert.ok(evidence.notes?.en && evidence.notes?.zh, `${definition.id}/${mode}: the evidence note is bilingual`);
      } else {
        liveModes.push(`${definition.id}/${mode}`);
      }
      const costs = operation.modeConstraints?.[mode];
      assert.ok(costs, `${definition.id}/${mode}: the cost and quota of the mode are declared`);
      assert.ok(costs.limits.en.trim() !== '' && costs.limits.zh.trim() !== '', `${definition.id}/${mode}: the cost note is bilingual`);
      assert.ok(costs.pricingUrl, `${definition.id}/${mode}: the cost note names its source`);
    }
    for (const format of operation.serves) assert.ok(['html', 'markdown'].includes(format));
    assert.ok(operation.docs.startsWith('http'), `${definition.id}: the operation names its documentation`);
    assert.ok(operation.notes?.en && operation.notes?.zh, `${definition.id}: the provider note is bilingual`);
  }
  // Only the modes actually exercised anonymously from this deployment may claim live evidence, and a
  // keyed mode never does: this deployment holds no provider key.
  assert.deepEqual(liveModes.sort(), ['anysearch/anonymous', 'keenable/anonymous', 'tavily/anonymous']);
  for (const definition of catalog) {
    for (const [mode, evidence] of Object.entries(definition.fetch?.evidence ?? {})) {
      if (mode === 'anonymous') continue;
      assert.equal(evidence.evidence, 'documented', `${definition.id}/${mode}: a keyed mode is documented only`);
    }
  }
});

test('a provider without a fetch operation keeps no fetch endpoint and cannot be selected', () => {
  for (const definition of catalog) {
    const row = defaultConfig().backends[definition.id]!.fetch;
    if (definition.fetch) continue;
    assert.equal(row.endpoint, '', `${definition.id}: a search-only provider keeps an inert fetch record`);
  }
});

// --- request shape ----------------------------------------------------------------------------

test('deepseek posts the documented Fetch body with the stored key and reads native Markdown', async () => {
  const { fetcher, calls } = fakeFetch(() => json(fixtures.deepseek()));
  const result = await fetchFromProvider(requestFor('deepseek', 'key', fetcher), callProviderTool);

  assert.equal(result.outcome, 'ok');
  assert.equal(result.markdown, fixtures.deepseek().content, 'content is native Markdown, never reconverted');
  assert.equal(result.representation, 'provider-markdown');
  assert.equal(result.title, 'Example article');
  assert.equal(result.statusCode, undefined, 'this operation reports no target status, so none is invented');
  assert.equal(result.apiStatus, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.deepseek.com/v1/tools/fetch');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(headersOf(calls[0]!).authorization, 'Bearer stored-provider-key');
  assert.deepEqual(bodyOf(calls[0]!), { url: 'https://example.com/page' }, 'the documented body is the URL alone');
});

test('serpex posts urls plus the requested format and reports the target status it returns', async () => {
  const { fetcher, calls } = fakeFetch(() => json(fixtures.serpex()));
  const result = await fetchFromProvider(requestFor('serpex', 'key', fetcher), callProviderTool);

  assert.equal(result.outcome, 'ok');
  assert.equal(result.markdown, '# Example\n\nnative markdown');
  assert.equal(result.representation, 'provider-markdown');
  assert.equal(result.statusCode, 200, 'results[0].status_code is the target status the provider reported');
  assert.equal(result.apiStatus, 200, 'the API status stays separate from it');
  assert.equal(result.finalUrl, 'https://example.com/final');
  assert.equal(calls[0]!.url, 'https://api.serpex.dev/api/crawl');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(headersOf(calls[0]!).authorization, 'Bearer stored-provider-key');
  assert.deepEqual(bodyOf(calls[0]!), { urls: ['https://example.com/page'], format: 'markdown' });
});

test('serpex returns the page HTML it was asked for, and never wraps Markdown as HTML', async () => {
  const { fetcher, calls } = fakeFetch(() => json(fixtures.serpex()));
  const result = await fetchFromProvider(requestFor('serpex', 'key', fetcher, { format: 'html' }), callProviderTool);

  assert.equal(result.outcome, 'ok');
  assert.equal(bodyOf(calls[0]!).format, 'html');
  assert.equal(result.html, '<!doctype html><html><body><p>native html</p></body></html>');
  assert.equal(result.markdown, undefined, 'the Markdown field is not filled from an HTML answer');
  assert.equal(result.representation, 'provider-html');
});

test('serpex classifies the target status apart from the API status', async () => {
  const { fetcher } = fakeFetch(() => json({ success: true, results: [{ url: 'https://example.com/page', success: false, markdown: '', status_code: 404, error: 'HTTP 404: Not Found', error_type: 'http' }] }));
  const result = await fetchFromProvider(requestFor('serpex', 'key', fetcher), callProviderTool);
  assert.equal(result.outcome, 'http-error');
  assert.equal(result.statusCode, 404, 'the target answered 404 according to the provider');
  assert.equal(result.apiStatus, 200, 'the API itself answered 200');
  assert.equal(result.error!.kind, 'http');
  assert.ok(result.notes.some(note => /reported http/.test(note)), 'the sanitized error type is kept as a note');
  assert.ok(!result.notes.some(note => /HTTP 404: Not Found/.test(note)), 'the provider error text is never echoed');
});

test('linkup always takes Markdown and asks for raw content only on an HTML request', async () => {
  const markdownCall = fakeFetch(() => json(fixtures.linkup()));
  const markdown = await fetchFromProvider(requestFor('linkup', 'key', markdownCall.fetcher), callProviderTool);
  assert.equal(markdown.outcome, 'ok');
  assert.equal(markdown.markdown, '# Linkup docs\n\nnative markdown');
  assert.equal(markdown.statusCode, undefined, 'no target status is reported, so none is invented');
  assert.equal(markdownCall.calls[0]!.url, 'https://api.linkup.so/v1/fetch');
  assert.equal(headersOf(markdownCall.calls[0]!).authorization, 'Bearer stored-provider-key');
  assert.deepEqual(bodyOf(markdownCall.calls[0]!), { url: 'https://example.com/page', mode: 'standard', renderJs: false }, 'raw content is not requested for a Markdown fetch');

  const htmlCall = fakeFetch(() => json(fixtures.linkup()));
  const html = await fetchFromProvider(requestFor('linkup', 'key', htmlCall.fetcher, { format: 'html' }), callProviderTool);
  assert.equal(html.outcome, 'ok');
  assert.equal(html.html, '<!doctype html><html><body><p>raw page</p></body></html>');
  assert.equal(html.representation, 'provider-html');
  assert.equal(bodyOf(htmlCall.calls[0]!).includeRawContent, true, 'page HTML comes from the documented rawContent option');
});

test('linkup refuses to present a non-HTML raw body as the page HTML', async () => {
  const { fetcher } = fakeFetch(() => json({ markdown: '# md', favicon: 'https://x', rawContent: '%PDF-1.7 binary', contentType: 'application/pdf' }));
  const result = await fetchFromProvider(requestFor('linkup', 'key', fetcher, { format: 'html' }), callProviderTool);
  assert.equal(result.outcome, 'unsupported-content');
  assert.equal(result.html, undefined, 'a PDF body is never labelled as the page HTML');
});

test('tavily keyless sends the documented header and no credential, and its keyed mode sends the key only', async () => {
  const anonymous = fakeFetch(() => json(fixtures.tavily()));
  const keyless = await fetchFromProvider(requestFor('tavily', 'anonymous', anonymous.fetcher), callProviderTool);
  assert.equal(keyless.outcome, 'ok');
  assert.equal(anonymous.calls[0]!.url, 'https://api.tavily.com/extract');
  assert.equal(headersOf(anonymous.calls[0]!)['x-tavily-access-mode'], 'keyless');
  assert.equal(headersOf(anonymous.calls[0]!).authorization, undefined, 'an anonymous mode sends no credential');
  assert.deepEqual(bodyOf(anonymous.calls[0]!), { urls: ['https://example.com/page'], format: 'markdown', extract_depth: 'basic' });
  assert.equal(keyless.markdown, 'native extracted content');
  assert.equal(keyless.title, 'Example Domain', 'the title the live answer carried is captured when present');
  assert.equal(keyless.statusCode, undefined, 'no target status is reported, so none is invented');

  const keyed = fakeFetch(() => json(fixtures.tavily()));
  await fetchFromProvider(requestFor('tavily', 'key', keyed.fetcher), callProviderTool);
  assert.equal(headersOf(keyed.calls[0]!).authorization, 'Bearer stored-provider-key');
  assert.equal(headersOf(keyed.calls[0]!)['x-tavily-access-mode'], undefined, 'the keyed mode sends no keyless marker');
});

test('tavily passes plain text through as text, not as native Markdown', async () => {
  const { fetcher, calls } = fakeFetch(() => json(fixtures.tavily()));
  const result = await fetchFromProvider(requestFor('tavily', 'anonymous', fetcher, { options: { format: 'text', extract_depth: 'advanced' } }), callProviderTool);
  assert.equal(bodyOf(calls[0]!).format, 'text');
  assert.equal(bodyOf(calls[0]!).extract_depth, 'advanced');
  assert.equal(result.text, 'native extracted content');
  assert.equal(result.markdown, undefined);
  assert.equal(result.representation, 'response-text');
});

test('tavily reports a URL it could not process as a provider failure with no target status', async () => {
  const { fetcher } = fakeFetch(() => json({ results: [], failed_results: [{ url: 'https://example.com/page', error: 'Failed to retrieve content: secret tenant 42' }] }));
  const result = await fetchFromProvider(requestFor('tavily', 'anonymous', fetcher), callProviderTool);
  assert.equal(result.outcome, 'provider-error');
  assert.equal(result.statusCode, undefined, 'a failed extraction is not a target status');
  assert.equal(result.apiStatus, 200);
  assert.ok(result.notes.some(note => /could not process this URL/.test(note)));
  assert.ok(!result.notes.some(note => /secret tenant/.test(note)), 'the provider error text is never echoed');
});

test('you.com asks for exactly the requested format and returns it verbatim', async () => {
  const markdownCall = fakeFetch(() => json(fixtures.you()));
  const markdown = await fetchFromProvider(requestFor('you', 'key', markdownCall.fetcher), callProviderTool);
  assert.equal(markdown.outcome, 'ok');
  assert.equal(markdown.markdown, '# Example Page\n\nnative markdown');
  assert.equal(markdown.title, 'Example Page');
  assert.equal(markdown.statusCode, undefined, 'no target status is reported, so none is invented');
  assert.equal(markdownCall.calls[0]!.url, 'https://ydc-index.io/v1/extract');
  assert.equal(headersOf(markdownCall.calls[0]!)['x-api-key'], 'stored-provider-key');
  assert.deepEqual(bodyOf(markdownCall.calls[0]!), { url: 'https://example.com/page', full_page: { extraction_formats: ['markdown'] } });

  const htmlCall = fakeFetch(() => json(fixtures.you()));
  const html = await fetchFromProvider(requestFor('you', 'key', htmlCall.fetcher, { format: 'html' }), callProviderTool);
  assert.deepEqual(bodyOf(htmlCall.calls[0]!), { url: 'https://example.com/page', full_page: { extraction_formats: ['html'] } });
  assert.equal(html.html, '<h1>Example Page</h1><p>native html</p>');
  assert.equal(html.representation, 'provider-html');
});

test('you.com reports an empty contents object as having no usable page', async () => {
  const { fetcher } = fakeFetch(() => json({ url: 'https://example.com/page', contents: {} }));
  const result = await fetchFromProvider(requestFor('you', 'key', fetcher), callProviderTool);
  assert.equal(result.outcome, 'unsupported-content');
});

test('keenable fetches over the documented GET query, with the title header keyless and the key keyed', async () => {
  const anonymous = fakeFetch(() => json(fixtures.keenable()));
  const keyless = await fetchFromProvider(requestFor('keenable', 'anonymous', anonymous.fetcher), callProviderTool);
  assert.equal(keyless.outcome, 'ok');
  const keylessCall = anonymous.calls[0]!;
  assert.equal(keylessCall.init.method, 'GET', 'the operation is a GET, not a contorted POST');
  assert.equal(keylessCall.init.body, undefined, 'a GET carries no body');
  assert.equal(new URL(keylessCall.url).origin + new URL(keylessCall.url).pathname, 'https://api.keenable.ai/v1/fetch/public');
  assert.equal(queryOf(keylessCall).get('url'), 'https://example.com/page');
  assert.equal(queryOf(keylessCall).get('max_chars'), '50000');
  assert.equal(queryOf(keylessCall).get('live'), 'false');
  assert.equal(headersOf(keylessCall)['X-Keenable-Title'], 'dsh-search', 'the public path requires the application title header');
  assert.equal(headersOf(keylessCall)['X-API-Key'], undefined, 'an anonymous mode sends no credential');
  assert.equal(keyless.markdown, 'native markdown from keenable');
  assert.equal(keyless.title, 'Example Domain');
  assert.equal(keyless.finalUrl, 'https://example.com/', 'the final URL after redirects is the one reported');
  assert.equal(keyless.statusCode, undefined, 'no target status is reported, so none is invented');

  const keyed = fakeFetch(() => json(fixtures.keenable()));
  await fetchFromProvider(requestFor('keenable', 'key', keyed.fetcher, { options: { clientTitle: 'dsh-search', max_chars: 8_000, live: true } }), callProviderTool);
  assert.equal(new URL(keyed.calls[0]!.url).pathname, '/v1/fetch');
  assert.equal(headersOf(keyed.calls[0]!)['X-API-Key'], 'stored-provider-key');
  assert.equal(headersOf(keyed.calls[0]!)['X-Keenable-Title'], undefined, 'the keyed path does not send the public title header');
  assert.equal(queryOf(keyed.calls[0]!).get('max_chars'), '8000');
  assert.equal(queryOf(keyed.calls[0]!).get('live'), 'true');
});

test('a truncated Keenable page is recorded as truncated by the provider', async () => {
  const { fetcher } = fakeFetch(() => json({ ...fixtures.keenable(), truncated: true, total_chars: 90_000 }));
  const result = await fetchFromProvider(requestFor('keenable', 'anonymous', fetcher), callProviderTool);
  assert.equal(result.outcome, 'ok');
  assert.ok(result.notes.some(note => /truncated the page at its own max_chars bound/.test(note)));
});

test('anysearch extracts cleaned text anonymously or with a key, and never relabels it', async () => {
  const anonymous = fakeFetch(() => json(fixtures.anysearch()));
  const keyless = await fetchFromProvider(requestFor('anysearch', 'anonymous', anonymous.fetcher), callProviderTool);
  assert.equal(keyless.outcome, 'ok');
  assert.equal(anonymous.calls[0]!.url, 'https://api.anysearch.com/v1/extract');
  assert.equal(headersOf(anonymous.calls[0]!).authorization, undefined, 'an anonymous mode sends no credential');
  assert.deepEqual(bodyOf(anonymous.calls[0]!), { url: 'https://example.com/page' }, 'the documented body is the URL alone');
  assert.equal(keyless.text, 'cleaned page text');
  assert.equal(keyless.markdown, undefined, 'cleaned text is not relabelled as native Markdown');
  assert.equal(keyless.representation, 'response-text');
  assert.equal(keyless.title, 'Example Article');
  assert.equal(keyless.statusCode, undefined, 'no target status is reported, so none is invented');

  const keyed = fakeFetch(() => json(fixtures.anysearch()));
  await fetchFromProvider(requestFor('anysearch', 'key', keyed.fetcher), callProviderTool);
  assert.equal(headersOf(keyed.calls[0]!).authorization, 'Bearer stored-provider-key');
});

test('an anysearch application-level error is a provider failure, not a page', async () => {
  const { fetcher } = fakeFetch(() => json({ code: -1, message: 'URL is invalid.', request_id: 'r' }));
  const result = await fetchFromProvider(requestFor('anysearch', 'anonymous', fetcher), callProviderTool);
  assert.equal(result.outcome, 'provider-error');
  assert.equal(result.statusCode, undefined);
  assert.ok(!result.notes.some(note => /URL is invalid/.test(note)), 'the provider message is never echoed');
});

test('doubao posts the documented body and separates the target status from an API error', async () => {
  const { fetcher, calls } = fakeFetch(() => json(fixtures.doubao()));
  const result = await fetchFromProvider(requestFor('doubao', 'key', fetcher), callProviderTool);

  assert.equal(result.outcome, 'ok');
  assert.equal(calls[0]!.url, 'https://open.feedcoopapi.com/search_api/fetch');
  assert.equal(headersOf(calls[0]!).authorization, 'Bearer stored-provider-key');
  assert.deepEqual(bodyOf(calls[0]!), { Url: 'https://example.com/page' }, 'the documented body field is Url');
  assert.equal(result.text, 'plain page text');
  assert.equal(result.markdown, undefined, 'plain text is not relabelled as Markdown');
  assert.equal(result.representation, 'response-text');
  assert.equal(result.title, '示例网页标题');
  assert.equal(result.statusCode, 200, 'Result.Data.StatusCode is the target status');
  assert.equal(result.finalUrl, 'https://example.com/final', 'RedirectedUrl is the final address when present');
});

test('doubao reports a target failure through Data.StatusCode with no content', async () => {
  const { fetcher } = fakeFetch(() => json({
    ResponseMetadata: { RequestId: 'r' },
    Result: { Data: { StatusCode: 404, Url: 'https://example.com/page', RedirectedUrl: null, Title: null, PublishTime: null, ContentText: null }, LogId: 'l' },
  }));
  const result = await fetchFromProvider(requestFor('doubao', 'key', fetcher), callProviderTool);
  assert.equal(result.outcome, 'http-error');
  assert.equal(result.statusCode, 404);
  assert.equal(result.apiStatus, 200, 'the API itself answered 200');
});

test('a doubao API error is named by its code and cannot become a target status', async () => {
  const { fetcher } = fakeFetch(() => json({ ResponseMetadata: { RequestId: 'r', Error: { CodeN: 10409, Code: '10409', Message: 'subscription key cannot fetch' } }, Result: null }));
  const result = await fetchFromProvider(requestFor('doubao', 'key', fetcher), callProviderTool);
  assert.equal(result.outcome, 'provider-error');
  assert.equal(result.statusCode, undefined, 'an API error never becomes a target status');
  assert.equal(result.apiStatus, 200);
  assert.ok(result.notes.some(note => /reported 10409/.test(note)), 'the stable code is named');
  assert.ok(!result.notes.some(note => /subscription key cannot fetch/.test(note)), 'the provider message is never echoed');
});

test('open-websearch posts the daemon request and reads its envelope', async () => {
  const { fetcher, calls } = fakeFetch(() => json(fixtures['open-websearch']()));
  const result = await fetchFromProvider(requestFor('open-websearch', 'anonymous', fetcher), callProviderTool);

  assert.equal(result.outcome, 'ok');
  assert.equal(calls[0]!.url, 'http://127.0.0.1:3210/fetch-web');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(bodyOf(calls[0]!), { url: 'https://example.com/page', maxChars: 30000, renderMode: 'auto' });
  assert.equal(headersOf(calls[0]!).authorization, undefined, 'the daemon takes no credential');
  assert.equal(result.text, 'extracted page text');
  assert.equal(result.markdown, undefined, 'the daemon payload is text, not native Markdown');
  assert.equal(result.title, undefined, 'an empty title is unavailable, never an empty string');
  assert.equal(result.finalUrl, 'https://example.com/final');
  assert.equal(result.statusCode, undefined, 'no target status is reported, so none is invented');
});

test('an open-websearch daemon error is a provider failure', async () => {
  const { fetcher } = fakeFetch(() => json({ status: 'error', data: null, error: { code: 'validation_failed', message: 'Use a valid URL' }, hint: 'Retry with a supported input' }));
  const result = await fetchFromProvider(requestFor('open-websearch', 'anonymous', fetcher), callProviderTool);
  assert.equal(result.outcome, 'provider-error');
  assert.ok(result.notes.some(note => /validation_failed/.test(note)));
});

// --- shared behaviour -------------------------------------------------------------------------

test('no REST provider follows a redirect, and every one of them sends the documented method', async () => {
  for (const providerId of Object.keys(fixtures) as ProviderId[]) {
    const definition = definitionOf(providerId);
    for (const mode of definition.fetch!.modes) {
      const { fetcher, calls } = fakeFetch(() => json((fixtures[providerId] as () => unknown)()));
      await fetchFromProvider(requestFor(providerId, mode, fetcher), callProviderTool);
      assert.equal(calls[0]!.init.redirect, 'error', `${providerId}/${mode}: a redirect is refused, not followed`);
      const expected = providerId === 'keenable' ? 'GET' : 'POST';
      assert.equal(calls[0]!.init.method, expected, `${providerId}/${mode}: the documented method`);
    }
  }
});

test('a provider API error status is classified by status alone, with no body echoed', async () => {
  const cases: Array<[number, string]> = [[401, 'authentication'], [402, 'provider-error'], [429, 'provider-error'], [500, 'provider-error']];
  for (const [status, outcome] of cases) {
    for (const providerId of Object.keys(fixtures) as ProviderId[]) {
      const definition = definitionOf(providerId);
      const mode = definition.fetch!.modes[0]!;
      const { fetcher, calls } = fakeFetch(() => json({ error: 'tenant secret 42 rejected the request' }, status));
      const result = await fetchFromProvider(requestFor(providerId, mode, fetcher), callProviderTool);
      assert.equal(result.outcome, outcome, `${providerId}: HTTP ${status} maps to ${outcome}`);
      assert.equal(result.apiStatus, status, `${providerId}: the API status is preserved`);
      assert.equal(result.statusCode, undefined, `${providerId}: an API status is never a target status`);
      assert.ok(!JSON.stringify(result).includes('tenant secret 42'), `${providerId}: the provider error body never reaches the result`);
      assert.equal(calls.length, 1);
    }
  }
});

test('a non-JSON answer is a protocol failure for every REST provider', async () => {
  for (const providerId of Object.keys(fixtures) as ProviderId[]) {
    const definition = definitionOf(providerId);
    const mode = definition.fetch!.modes[0]!;
    const { fetcher } = fakeFetch(() => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const result = await fetchFromProvider(requestFor(providerId, mode, fetcher), callProviderTool);
    assert.equal(result.outcome, 'protocol', `${providerId}: a non-JSON answer is a protocol failure`);
    assert.doesNotMatch(result.error!.message, /<html>/);
  }
});

test('an oversized provider answer is a fatal acquisition limit, not a partial page', async () => {
  for (const providerId of Object.keys(fixtures) as ProviderId[]) {
    const definition = definitionOf(providerId);
    const mode = definition.fetch!.modes[0]!;
    const huge = { ...(fixtures[providerId] as () => Record<string, unknown>)() } as Record<string, unknown>;
    huge.content = 'x'.repeat(50_000);
    huge.markdown = 'x'.repeat(50_000);
    huge.raw_content = 'x'.repeat(50_000);
    huge.data = { content: 'x'.repeat(50_000), title: 't' };
    const { fetcher } = fakeFetch(() => json(huge));
    const result = await fetchFromProvider(requestFor(providerId, mode, fetcher, { maxChars: 256 }), callProviderTool);
    // Either the wire bound or the representation bound trips first; both are the same fatal limit.
    assert.equal(result.outcome, 'limit', `${providerId}: an oversized answer is a limit`);
    assert.equal(result.fatal, true, `${providerId}: a limit never becomes a fallback`);
  }
});

test('a missing key is a non-fatal authentication attempt that sends no request', async () => {
  for (const providerId of Object.keys(fixtures) as ProviderId[]) {
    const definition = definitionOf(providerId);
    for (const mode of definition.fetch!.modes) {
      if (mode === 'anonymous') continue;
      const { fetcher, calls } = fakeFetch(() => json((fixtures[providerId] as () => unknown)()));
      const result = await fetchFromProvider(requestFor(providerId, mode, fetcher, { credential: undefined }), callProviderTool);
      assert.equal(result.outcome, 'authentication', `${providerId}/${mode}: the missing key is an authentication outcome`);
      assert.notEqual(result.fatal, true, `${providerId}/${mode}: it is not fatal`);
      assert.equal(result.statusCode, undefined, `${providerId}/${mode}: no target status is invented`);
      assert.equal(calls.length, 0, `${providerId}/${mode}: nothing is sent to learn what the configuration already says`);
      assert.ok(result.notes.some(note => /credential is missing/.test(note)));
      assert.ok(result.notes.some(note => /resolved the target outside this process/.test(note)), `${providerId}/${mode}: the delegated trust note is kept`);
    }
  }
});

test('no stored credential is ever echoed into a result, a note or an error message', async () => {
  const secret = 'sk-live-this-must-never-appear';
  for (const providerId of Object.keys(fixtures) as ProviderId[]) {
    const definition = definitionOf(providerId);
    for (const mode of definition.fetch!.modes) {
      if (mode === 'anonymous') continue;
      for (const response of [() => json((fixtures[providerId] as () => unknown)()), () => json({ error: 'denied' }, 401)]) {
        const { fetcher } = fakeFetch(response);
        const result = await fetchFromProvider(requestFor(providerId, mode, fetcher, { credential: secret }), callProviderTool);
        assert.ok(!JSON.stringify(result).includes(secret), `${providerId}/${mode}: the credential never leaves the request headers`);
      }
    }
  }
});

// --- engine integration -----------------------------------------------------------------------

const providerConfig = (providerId: string, mode: AccessMode, format: FetchFormat = 'markdown', change: (config: SearchConfig) => void = () => undefined): SearchConfig => {
  const config = defaultConfig();
  // All three route records stay: a saved configuration holds exactly one of each, and only the
  // provider route is enabled for these tests.
  for (const route of config.pageFetch.routes) route.enabled = route.kind === 'provider';
  config.pageFetch.providerId = providerId;
  const row = config.backends[providerId]!;
  row.fetch.mode = mode;
  // An empty saved endpoint means "use the one the mode declares", the same rule the settings page uses.
  row.fetch.endpoint = '';
  config.pageFetch.overallTimeoutMs = 20_000;
  change(config);
  assert.ok(format);
  return config;
};

test('each provider mode calls its declared endpoint and reuses the search credential reference', async () => {
  for (const definition of catalog) {
    const operation = definition.fetch;
    if (!operation) continue;
    for (const mode of operation.modes) {
      const { fetcher, calls } = fakeFetch(() => json((preExistingFixtures as Record<string, () => unknown>)[definition.id]?.() ?? (fixtures[definition.id as ProviderId] as () => unknown)()));
      // The two keyless MCP modes are observed through the MCP caller, not the REST seam: the engine
      // picks the transport from the saved mode, and each mode is asserted on the one it declares.
      const mcpCalls: Array<Record<string, unknown>> = [];
      const providerCall = (async (request: Record<string, unknown>) => {
        mcpCalls.push(request);
        const result = definition.id === 'exa'
          ? { content: [{ type: 'text', text: '# MCP page' }] }
          : { structuredContent: { results: [{ url: 'https://example.com/final', title: 'MCP page', full_content: '# MCP page', excerpts: [] }], errors: [] } };
        return { result, apiStatus: 200 };
      }) as never;
      const refs: string[] = [];
      const engine = createPageFetchEngine(providerConfig(definition.id, mode), {
        resolver: publicResolver,
        resolveCredential: async ref => { refs.push(ref); return 'shared-search-key'; },
        providerFetcher: fetcher,
        providerCall,
      });
      const result = await engine.fetchPage({ url: 'https://example.com/page', format: 'markdown' });
      assert.equal(result.ok, true, `${definition.id}/${mode}: the chain accepts the page`);
      assert.equal(result.contentProvider, definition.id);
      assert.ok(result.notes.some(note => /resolved the target outside this process/.test(note)), `${definition.id}/${mode}: the delegated trust note is kept`);
      if ((operation.transport?.[mode] ?? 'mcp') === 'mcp') {
        assert.equal(calls.length, 0, `${definition.id}/${mode}: an MCP mode sends no REST request`);
        assert.equal(mcpCalls.length, 1, `${definition.id}/${mode}: one MCP tool call`);
        assert.equal(mcpCalls[0]!.endpoint, operation.endpoints?.[mode] ?? definition.modes.find(item => item.mode === mode)?.fetchEndpoint);
        assert.equal(mcpCalls[0]!.credential, undefined, `${definition.id}/${mode}: an anonymous MCP call carries no credential`);
        assert.deepEqual(refs, [], `${definition.id}/${mode}: an anonymous mode resolves no credential`);
        continue;
      }
      assert.equal(mcpCalls.length, 0, `${definition.id}/${mode}: a REST mode makes no MCP call`);
      assert.equal(calls.length, 1, `${definition.id}/${mode}: one request, no retry`);
      const declaredEndpoint: string | undefined = operation.endpoints?.[mode] ?? definition.modes.find(item => item.mode === mode)?.fetchEndpoint;
      const called = new URL(calls[0]!.url);
      // A documented GET operation carries its parameters in the query string; the endpoint itself is
      // the origin and path, never a rewritten URL.
      assert.equal(called.origin + called.pathname, declaredEndpoint, `${definition.id}/${mode}: the declared endpoint`);
      if (mode === 'anonymous') {
        assert.deepEqual(refs, [], `${definition.id}/${mode}: an anonymous mode resolves no credential`);
        assert.equal(headersOf(calls[0]!).authorization ?? headersOf(calls[0]!)['x-api-key'], undefined, `${definition.id}/${mode}: no credential is sent`);
      } else {
        assert.deepEqual(refs, [backendCredentialRef(definition.id)], `${definition.id}/${mode}: one fixed credential reference, shared with search`);
      }
    }
  }
});

test('an HTML request is skipped before a request for providers that cannot return HTML, and served where they can', async () => {
  for (const definition of catalog) {
    const operation = definition.fetch;
    if (!operation) continue;
    const mode = operation.modes[0]!;
    const { fetcher, calls } = fakeFetch(() => json((fixtures[definition.id as ProviderId] as () => unknown)()));
    const engine = createPageFetchEngine(providerConfig(definition.id, mode, 'html'), {
      resolver: publicResolver,
      resolveCredential: async () => 'shared-search-key',
      providerFetcher: fetcher,
    });
    const result = await engine.fetchPage({ url: 'https://example.com/page', format: 'html' });
    const attempt = result.attempts[0]!;
    if (operation.serves.includes('html')) {
      assert.equal(calls.length, 1, `${definition.id}: an HTML-capable provider really is called`);
      if ((fixtures[definition.id as ProviderId] as () => Record<string, unknown>)().html || definition.id === 'serpex' || definition.id === 'you' || definition.id === 'linkup') {
        assert.equal(result.ok, true, `${definition.id}: the provider's own HTML is served`);
        assert.equal(result.representation, 'provider-html');
        assert.match(result.content!, /</, `${definition.id}: the content really is markup, not text`);
      }
    } else {
      assert.equal(attempt.outcome, 'unsupported-format', `${definition.id}: a text-only provider cannot serve HTML`);
      assert.equal(calls.length, 0, `${definition.id}: nothing is sent when the format cannot be served`);
      assert.equal(result.content, undefined);
    }
  }
});

test('a keyed fetch with no stored key stays non-fatal and lets the chain fall back', async () => {
  const config = providerConfig('deepseek', 'key', 'markdown', config => {
    const providerRoute = config.pageFetch.routes.find(route => route.kind === 'provider')!;
    providerRoute.rules = [{ id: 'no-key', enabled: true, conditions: [{ type: 'error', kinds: ['authentication'] }] }];
  });
  const { fetcher, calls } = fakeFetch(() => new Response('<html><body><p>http fallback</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  // A later HTTP route is what a matched authentication rule falls through to.
  const providerRoute = config.pageFetch.routes.find(route => route.kind === 'provider')!;
  const httpRoute = config.pageFetch.routes.find(route => route.kind === 'http')!;
  config.pageFetch.routes = [providerRoute, { ...httpRoute, enabled: true }];
  const engine = createPageFetchEngine(config, { resolver: publicResolver, resolveCredential: async () => undefined, fetcher, providerFetcher: fetcher });
  const result = await engine.fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(result.ok, true, 'the chain serves the page over the next route');
  assert.deepEqual(result.attempts.map(attempt => attempt.route), ['provider', 'http']);
  assert.equal(result.attempts[0]!.outcome, 'authentication');
  assert.deepEqual(result.attempts[0]!.rules, ['no-key']);
  assert.equal(calls.length, 1, 'only the HTTP route sent a request');
  assert.equal(calls[0]!.url, 'https://example.com/page');
});

test('every declared provider mode validates, and a saved record reloads in the same mode', () => {
  for (const definition of catalog) {
    const operation = definition.fetch;
    if (!operation) continue;
    for (const mode of operation.modes) {
      const config = providerConfig(definition.id, mode);
      const issues = validateConfig(config).filter(issue => issue.path.startsWith('pageFetch') || issue.path.includes('.fetch'));
      assert.deepEqual(issues, [], `${definition.id}/${mode}: the saved chain is valid`);
      const reloaded = parseConfig(JSON.parse(JSON.stringify(config)));
      assert.equal(reloaded.backends[definition.id]!.fetch.mode, mode, `${definition.id}/${mode}: the mode survives a reload`);
      assert.equal(reloaded.backends[definition.id]!.fetch.endpoint, '', `${definition.id}/${mode}: an empty endpoint still means "the declared one"`);
    }
  }
});

test('an inert fetch record from an older release becomes the operation default, and a configured one is not reset', () => {
  // The shape an older release wrote for a provider that had no fetch operation: its first search
  // mode, no endpoint and no options. You.com now fetches with a key only, so that mode is gone.
  const saved = structuredClone(defaultConfig()) as unknown as Record<string, any>;
  saved.backends.you.fetch = { mode: 'anonymous', endpoint: '', timeoutMs: 15_000, options: {} };
  const reloaded = parseConfig(saved);
  assert.equal(reloaded.backends.you!.fetch.mode, 'key', 'the inert record takes the operation default');
  assert.equal(reloaded.backends.you!.fetch.endpoint, 'https://ydc-index.io/v1/extract');
  assert.equal(reloaded.backends.you!.mode, 'anonymous', 'the search row is untouched');

  // A record somebody actually configured is never rewritten: validation reports it instead.
  const configured = structuredClone(defaultConfig()) as unknown as Record<string, any>;
  configured.backends.you.fetch = { mode: 'anonymous', endpoint: 'https://example.com/custom-fetch', timeoutMs: 15_000, options: {} };
  const issues = validateConfig(configured);
  assert.ok(issues.some(issue => issue.path === 'backends.you.fetch.mode'), 'an unsupported configured mode is reported');
});

test('the doubao caveat is stated where a user selects it, in both languages', () => {
  const doubao = definitionOf('doubao');
  const notes = doubao.fetch!.notes!;
  assert.match(notes.en, /pay-as-you-go/i);
  assert.match(notes.en, /subscription/i);
  assert.match(notes.en, /10409/);
  assert.match(notes.zh, /按量后付费/);
  assert.match(notes.zh, /订阅套餐/);
  assert.match(notes.zh, /10409/);
  const costs = doubao.fetch!.modeConstraints!.key!.limits;
  assert.match(costs.en, /pay-as-you-go/i);
  assert.match(costs.zh, /按量后付费/);
});
