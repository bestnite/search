import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backendCredentialRef, defaultConfig, parseConfig, validateConfig } from '../src/config.js';
import { catalog } from '../src/catalog.js';
import { createPageFetchEngine } from '../src/fetch/engine.js';
import { utf8ByteLength } from '../src/fetch/bytes.js';
import { callProviderTool, fetchFromProvider, type ProviderRouteRequest } from '../src/fetch/provider.js';
import { callMcp } from '../src/mcp.js';
import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';
import type { TransportOptions } from '../src/transport.js';
import { createBrowserFetcher } from '../src/fetch/browser-route.js';
import { PageFetchError, type FetchFallbackRule, type FetchRouteKind, type PageFetchConfig } from '../src/fetch/types.js';
import { CLOUDFLARE_CHALLENGE_PRESET, DEFAULT_FALLBACK_RULES, STATUS_ERROR_PRESET, validateRules } from '../src/fetch/rules.js';
import { htmlToMarkdown, parseHtmlDocument } from '../src/fetch/html.js';
import { createPinnedLookup } from '../src/fetch/http.js';
import { SearchError } from '../src/transport.js';
import type { SearchConfig } from '../src/types.js';
import type { BrowserFetcher } from '../src/fetch/browser-route.js';

/**
 * Deterministic coverage for the page-fetch engine. Every route is driven through its injection
 * seam: a fake fetcher for HTTP, a fake connect for the browser transport, and a fake MCP caller for
 * provider adapters. No test here touches a real network or a real browser.
 */

const publicResolver = async (): Promise<string[]> => ['93.184.216.34'];

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  return { fetcher, calls };
}

const htmlResponse = (body: string, status = 200, type = 'text/html; charset=utf-8'): Response =>
  new Response(body, { status, headers: { 'content-type': type } });

const pageOf = (config: SearchConfig): PageFetchConfig => config.pageFetch;
const routeOf = (page: PageFetchConfig, kind: FetchRouteKind) => page.routes.find(route => route.kind === kind)!;

function pageConfig(change: (page: PageFetchConfig, config: SearchConfig) => void = () => undefined): SearchConfig {
  const config = defaultConfig();
  // Any test that enables the browser route needs an endpoint; setting it here keeps the fixtures
  // focused on the behaviour under test instead of repeating connection plumbing.
  config.browser.endpoint = 'ws://127.0.0.1:3030/ws';
  change(config.pageFetch, config);
  return config;
}

const rule = (id: string, ...conditions: FetchFallbackRule['conditions']): FetchFallbackRule => ({ id, enabled: true, conditions });

function engineFor(config: SearchConfig, dependencies: Parameters<typeof createPageFetchEngine>[1] = {}) {
  return createPageFetchEngine(config, { resolver: publicResolver, ...dependencies });
}

/** Provider caller that replays fixed observations and records every request it was given. */
function fakeProvider(replies: Array<() => { result: Record<string, unknown>; apiStatus?: number } | Promise<{ result: Record<string, unknown>; apiStatus?: number }>>) {
  const calls: Array<Record<string, unknown>> = [];
  let index = 0;
  const call = async (request: Record<string, unknown>) => {
    calls.push(request);
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (!reply) throw new Error('no fake reply configured');
    return reply();
  };
  return { call: call as never, calls };
}

/** Browser transport whose driver calls resolve late, to exercise aborts during connect/context/page. */
function delayedBrowser(options: { html?: string; delayMs?: number; step: 'connect' | 'context' | 'page' } = { step: 'connect' }) {
  const events: string[] = [];
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const html = options.html ?? '<html><body><p>late browser page</p></body></html>';
  const delayMs = options.delayMs ?? 40;
  const page = {
    goto: async () => { events.push('page.goto'); return { status: () => 200 }; },
    waitForSelector: async () => undefined,
    evaluate: async (_script: unknown, limit: number) => {
      const bytes = new TextEncoder().encode(html).byteLength;
      return bytes > limit ? { tooLarge: bytes } : { html };
    },
    url: () => 'https://example.com/late',
    close: async () => { events.push('page.close'); },
  };
  const context = {
    newPage: async () => {
      if (options.step === 'page') await delay(delayMs);
      events.push('context.newPage');
      return page;
    },
    close: async () => { events.push('context.close'); },
  };
  const browser = {
    newContext: async () => {
      if (options.step === 'context') await delay(delayMs);
      events.push('browser.newContext');
      return context;
    },
    close: async () => { events.push('browser.close'); },
    isConnected: () => true,
  };
  const connect = async () => {
    if (options.step === 'connect') await delay(delayMs);
    events.push('connect');
    return browser as never;
  };
  return { fetcher: createBrowserFetcher(connect), events, delayMs };
}

const exaMarkdown = (text: string) => () => ({ result: { content: [{ type: 'text', text }] }, apiStatus: 200 });
const exaFailure = () => () => ({ result: { content: [{ type: 'text', text: 'Error fetching URL(s): https://example.com/x: CRAWL_NOT_FOUND' }], isError: true }, apiStatus: 200 });
const parallelSuccess = (markdown: string, title = 'Example Page') => () => ({
  result: { structuredContent: { results: [{ url: 'https://example.com/final', title, full_content: markdown }], errors: [] } },
  apiStatus: 200,
});
const parallelNotFound = () => () => ({
  result: { structuredContent: { results: [], errors: [{ url: 'https://example.com/x', error_type: 'http_error', http_status_code: 404 }] } },
  apiStatus: 200,
});

/** Browser transport driven by a fake driver: records cleanup and the context it was asked for. */
function fakeBrowser(options: { html?: string; title?: string; status?: number; failGoto?: Error; finalUrl?: string; capture?: 'limit' | 'ignore' } = {}) {
  const events: string[] = [];
  const page = {
    goto: async () => {
      events.push('page.goto');
      if (options.failGoto) throw options.failGoto;
      return { status: () => options.status ?? 200 };
    },
    waitForSelector: async (selector: string) => {
      events.push(`page.waitForSelector:${selector}`);
    },
    title: async () => options.title ?? 'Browser Title',
    evaluate: async (_script: unknown, limit: number) => {
      const html = options.html ?? '<html><head><title>Browser Title</title></head><body><p>rendered</p></body></html>';
      // Mirrors the in-page byte measurement; 'ignore' simulates a page without the remote guard.
      if (options.capture === 'ignore') return { html };
      const bytes = new TextEncoder().encode(html).byteLength;
      return bytes > limit ? { tooLarge: bytes } : { html };
    },
    url: () => options.finalUrl ?? 'https://example.com/final',
    close: async () => {
      events.push('page.close');
    },
  };
  const context = {
    newPage: async () => page,
    close: async () => {
      events.push('context.close');
    },
  };
  const browser = {
    newContext: async (settings: Record<string, unknown>) => {
      events.push(`browser.newContext:${JSON.stringify(settings)}`);
      return context;
    },
    close: async () => {
      events.push('browser.close');
    },
    isConnected: () => true,
  };
  const connect = async (endpoint: string, settings: { headers?: Record<string, string> }) => {
    events.push(`connect:${endpoint}:${JSON.stringify(settings.headers ?? {})}`);
    return browser as never;
  };
  return { fetcher: createBrowserFetcher(connect), events };
}

// --- input validation -------------------------------------------------------------------------

test('url and format are validated before any request is sent', async () => {
  const { fetcher, calls } = fakeFetch(() => htmlResponse('<html>ok</html>'));
  const engine = engineFor(pageConfig(), { fetcher });
  for (const format of [undefined, null, 'text', 'HTML'] as unknown[]) {
    await assert.rejects(
      () => engine.fetchPage({ url: 'https://example.com', format: format as never }),
      (error: unknown) => error instanceof PageFetchError && error.kind === 'invalid-input',
      `format ${String(format)} must be refused`,
    );
  }
  for (const url of ['', 'not a url', 'ftp://example.com/page', 'file:///etc/passwd', 'https://user:secret@example.com/page']) {
    await assert.rejects(
      () => engine.fetchPage({ url, format: 'markdown' }),
      (error: unknown) => error instanceof PageFetchError && error.kind === 'invalid-input',
      `url ${url} must be refused`,
    );
  }
  assert.equal(calls.length, 0, 'a rejected input must not reach the network');
});

test('a configuration with every route disabled is refused before execution', async () => {
  const config = pageConfig(page => {
    for (const route of page.routes) route.enabled = false;
  });
  await assert.rejects(() => engineFor(config).fetchPage({ url: 'https://example.com', format: 'markdown' }), (error: unknown) => error instanceof PageFetchError && error.kind === 'configuration');
});

// --- route order, enablement and sequencing ---------------------------------------------------

test('routes run one at a time in the configured order and disabled routes are skipped', async () => {
  const order: string[] = [];
  const config = pageConfig(page => {
    page.providerId = 'exa';
    page.routes = [routeOf(page, 'provider'), routeOf(page, 'browser'), routeOf(page, 'http')];
    for (const route of page.routes) route.enabled = true;
  });
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const browser = fakeBrowser({ html: '<html><body>rendered</body></html>' });
  const slowBrowser = (async () => {
    order.push('browser:start');
    await wait(10);
    order.push('browser:end');
    return { outcome: 'network', error: { kind: 'network', message: 'browser down' }, notes: [] };
  }) as BrowserFetcher;
  assert.ok(browser);
  const provider = fakeProvider([async () => {
    order.push('provider:start');
    await wait(10);
    order.push('provider:end');
    throw new SearchError('network', 'unreachable');
  }]);
  const { fetcher } = fakeFetch(async () => {
    order.push('http:start');
    await wait(10);
    order.push('http:end');
    return htmlResponse('<html><body><p>http body</p></body></html>');
  });
  const engine = engineFor(config, { fetcher, browser: slowBrowser, providerCall: provider.call });
  const result = await engine.fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(result.ok, true);
  assert.equal(result.contentRoute, 'http');
  assert.deepEqual(order, ['provider:start', 'provider:end', 'browser:start', 'browser:end', 'http:start', 'http:end'], 'no two routes may overlap');
  assert.deepEqual(result.attempts.map(attempt => attempt.route), ['provider', 'browser', 'http']);
});

test('the provider route calls exactly the selected provider and no other', async () => {
  const config = pageConfig(page => {
    page.providerId = 'parallel';
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'provider').enabled = true;
  });
  const provider = fakeProvider([parallelSuccess('# Page\n\nbody')]);
  const result = await engineFor(config, { providerCall: provider.call }).fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(result.ok, true);
  assert.equal(result.contentProvider, 'parallel');
  assert.equal(provider.calls.length, 1);
  const sent = provider.calls[0]!;
  assert.equal(sent.tool, 'web_fetch');
  assert.equal(sent.endpoint, 'https://mcp.parallel.ai/mcp');
  assert.deepEqual(sent.args, { urls: ['https://example.com/page'], full_content: true }, 'only the target URL is forwarded, with no cookies or headers');
});

test('a disabled provider route is never called even when a provider is selected', async () => {
  const config = pageConfig(page => {
    page.providerId = 'exa';
  });
  const provider = fakeProvider([exaMarkdown('should not be used')]);
  const { fetcher } = fakeFetch(() => htmlResponse('<html><body>http</body></html>'));
  const result = await engineFor(config, { fetcher, providerCall: provider.call }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(result.ok, true);
  assert.equal(provider.calls.length, 0);
});

// --- fallback rules ---------------------------------------------------------------------------

test('rules are OR across a route and AND inside one rule', async () => {
  const config = pageConfig(page => {
    routeOf(page, 'http').rules = [
      rule('both', { type: 'match', field: 'title', operator: 'contains', value: 'Example', caseSensitive: false }, { type: 'match', field: 'html', operator: 'contains', value: 'FallbackMe', caseSensitive: false }),
      rule('other', { type: 'status', statuses: [418] }),
    ];
    page.routes = [routeOf(page, 'http'), ...page.routes.filter(route => route.kind === 'browser')];
    routeOf(page, 'browser').enabled = true;
    routeOf(page, 'browser').rules = DEFAULT_FALLBACK_RULES;
  });
  const browser = fakeBrowser({ html: '<html><body>second route</body></html>' });
  const { fetcher } = fakeFetch(() => htmlResponse('<html><head><title>Example</title></head><body>FallbackMe</body></html>'));
  const result = await engineFor(config, { fetcher, browser: browser.fetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(result.ok, true);
  assert.equal(result.contentRoute, 'browser', 'the AND rule matched and the chain continued');
  assert.deepEqual(result.attempts[0]!.rules, ['both']);
});

test('an AND rule with an unavailable field does not match and says why', async () => {
  const config = pageConfig(page => {
    page.providerId = 'exa';
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'provider').enabled = true;
    routeOf(page, 'provider').rules = [
      rule('title-and-status', { type: 'match', field: 'title', operator: 'contains', value: 'Example', caseSensitive: false }, { type: 'status', statuses: [200] }),
    ];
  });
  const provider = fakeProvider([exaMarkdown('# Example\n\nbody')]);
  const result = await engineFor(config, { providerCall: provider.call }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(result.ok, true, 'no rule matched because a field was unavailable');
  const attempt = result.attempts[0]!;
  assert.deepEqual(attempt.rules, []);
  assert.ok(attempt.unavailable.some(reason => reason.startsWith('title:')), 'the missing provider title is named');
  assert.ok(attempt.unavailable.some(reason => reason.startsWith('status:')), 'the unknown target status is named, even though the rule already failed on the title');
});

test('string conditions honour explicit case sensitivity and never invent an empty field', async () => {
  const build = (caseSensitive: boolean) => pageConfig(page => {
    routeOf(page, 'http').rules = [rule('moment', { type: 'match', field: 'title', operator: 'contains', value: 'just a moment', caseSensitive })];
    routeOf(page, 'browser').enabled = true;
    routeOf(page, 'browser').rules = DEFAULT_FALLBACK_RULES;
  });
  const html = '<html><head><title>JUST A MOMENT</title></head><body>page</body></html>';
  const strict = fakeFetch(() => htmlResponse(html));
  const strictResult = await engineFor(build(true), { fetcher: strict.fetcher, browser: fakeBrowser().fetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(strictResult.contentRoute, 'http', 'a case-sensitive rule does not match different case');

  const loose = fakeFetch(() => htmlResponse(html));
  const looseResult = await engineFor(build(false), { fetcher: loose.fetcher, browser: fakeBrowser().fetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(looseResult.contentRoute, 'browser', 'a case-insensitive rule matches');
});

test('the Cloudflare preset combines title and HTML markers and ignores a bare mention', async () => {
  const build = () => pageConfig(page => {
    routeOf(page, 'http').rules = [...DEFAULT_FALLBACK_RULES, structuredClone(CLOUDFLARE_CHALLENGE_PRESET)];
    routeOf(page, 'browser').enabled = true;
    routeOf(page, 'browser').rules = DEFAULT_FALLBACK_RULES;
  });
  const challenge = fakeFetch(() => htmlResponse('<html><head><title>Just a moment...</title></head><body><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></body></html>'));
  const challenged = await engineFor(build(), { fetcher: challenge.fetcher, browser: fakeBrowser().fetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(challenged.contentRoute, 'browser', 'a real 200 challenge page falls through');
  assert.deepEqual(challenged.attempts[0]!.rules, ['cloudflare-challenge']);

  const falsePositive = fakeFetch(() => htmlResponse('<html><head><title>Just a moment of Cloudflare history</title></head><body>Cloudflare is a company; nothing here is a challenge.</body></html>'));
  const accepted = await engineFor(build(), { fetcher: falsePositive.fetcher, browser: fakeBrowser().fetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(accepted.contentRoute, 'http', 'a page that only mentions the vendor is not treated as a challenge');
  assert.deepEqual(accepted.attempts[0]!.rules, []);
});

test('the status preset is an ordinary editable rule, not hidden behaviour', async () => {
  const config = pageConfig(page => {
    routeOf(page, 'http').rules = [...DEFAULT_FALLBACK_RULES, structuredClone(STATUS_ERROR_PRESET)];
    routeOf(page, 'browser').enabled = true;
    routeOf(page, 'browser').rules = DEFAULT_FALLBACK_RULES;
  });
  const { fetcher } = fakeFetch(() => htmlResponse('<html><body>gone</body></html>', 410));
  const result = await engineFor(config, { fetcher, browser: fakeBrowser().fetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(result.contentRoute, 'browser');
  assert.deepEqual(result.attempts[0]!.rules, ['status-errors']);
});

test('regex conditions are linear-time, bounded and validated on save', async () => {
  const issues = validateRules([rule('look', { type: 'match', field: 'text', operator: 'regex', value: '(?=secret)', caseSensitive: true })], 'http', 'rules');
  assert.ok(issues.some(issue => /Unsupported regular expression/.test(issue)), 'lookaround is rejected at save time');

  const config = pageConfig(page => {
    routeOf(page, 'http').rules = [rule('linear', { type: 'match', field: 'text', operator: 'regex', value: '(a+)+b', caseSensitive: true })];
  });
  const { fetcher } = fakeFetch(() => htmlResponse('a'.repeat(200_000), 200, 'text/plain'));
  const started = Date.now();
  const result = await engineFor(config, { fetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.ok(Date.now() - started < 2_000, 'a pathological pattern over 200k characters stays linear');
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts[0]!.rules, [], 'no match, and no backtracking blow-up');
});

// --- result semantics -------------------------------------------------------------------------

test('a target 404 and 500 stop the chain with ok:false and no implicit retry', async () => {
  for (const status of [404, 500]) {
    const { fetcher, calls } = fakeFetch(() => htmlResponse('<html><body>error body</body></html>', status));
    const result = await engineFor(pageConfig(), { fetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' });
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, 'stopped-on-error');
    assert.equal(result.statusCode, status);
    assert.match(result.content ?? '', /error body/, 'the bounded body is returned as diagnostic content');
    assert.equal(calls.length, 1, 'no implicit retry');
    assert.equal(result.attempts[0]!.outcome, 'http-error');
  }
});

test('a matching rule on a 404 continues the chain instead of accepting the error page', async () => {
  const config = pageConfig(page => {
    routeOf(page, 'http').rules = [...DEFAULT_FALLBACK_RULES, structuredClone(STATUS_ERROR_PRESET)];
    routeOf(page, 'browser').enabled = true;
    routeOf(page, 'browser').rules = DEFAULT_FALLBACK_RULES;
  });
  const { fetcher } = fakeFetch(() => htmlResponse('<html><body>not here</body></html>', 404));
  const result = await engineFor(config, { fetcher, browser: fakeBrowser().fetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(result.ok, true);
  assert.equal(result.contentRoute, 'browser');
});

test('target status stays separate from provider API status', async () => {
  const config = pageConfig(page => {
    page.providerId = 'parallel';
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'provider').enabled = true;
    routeOf(page, 'provider').rules = [rule('target-404', { type: 'status', statuses: [404] })];
  });
  const provider = fakeProvider([parallelNotFound()]);
  const result = await engineFor(config, { providerCall: provider.call }).fetchPage({ url: 'https://example.com/x', format: 'markdown' });
  const attempt = result.attempts[0]!;
  assert.equal(attempt.statusCode, 404, 'the target status is recorded');
  assert.equal(attempt.apiStatus, 200, 'the provider API answered 200 and stays separate');
  assert.equal(attempt.outcome, 'http-error');
  // The rule matched, so the chain continues; there is no second route, so the result is exhausted.
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.ok, false);
});

test('a provider failure without a target status never invents one, and its body is not echoed', async () => {
  const config = pageConfig(page => {
    page.providerId = 'exa';
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'provider').enabled = true;
  });
  const provider = fakeProvider([exaFailure()]);
  const result = await engineFor(config, { providerCall: provider.call }).fetchPage({ url: 'https://example.com/x', format: 'markdown' });
  const attempt = result.attempts[0]!;
  assert.equal(attempt.statusCode, undefined, 'no target status is reported by this provider');
  assert.equal(attempt.outcome, 'provider-error');
  assert.equal(result.ok, false);
  assert.doesNotMatch(attempt.error!.message, /CRAWL_NOT_FOUND/, 'the provider body is not copied into the diagnostic message');
  assert.ok(result.notes.some(note => /CRAWL_NOT_FOUND/.test(note)), 'only the short machine code is mentioned in notes');
});

test('a provider protocol failure produces a sanitized error', async () => {
  const config = pageConfig(page => {
    page.providerId = 'parallel';
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'provider').enabled = true;
  });
  const provider = fakeProvider([() => ({ result: { content: [{ type: 'text', text: 'sorry, not json' }] }, apiStatus: 200 })]);
  const result = await engineFor(config, { providerCall: provider.call }).fetchPage({ url: 'https://example.com/x', format: 'markdown' });
  assert.equal(result.ok, false);
  assert.equal(result.attempts[0]!.outcome, 'protocol');
  assert.doesNotMatch(result.attempts[0]!.error!.message, /sorry, not json/);
});

test('a provider API rejection reports the API status, not a target status', async () => {
  const config = pageConfig(page => {
    page.providerId = 'exa';
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'provider').enabled = true;
  });
  const providerCall = async () => {
    throw new SearchError('http', 'HTTP 503', 503);
  };
  const result = await engineFor(config, { providerCall: providerCall as never }).fetchPage({ url: 'https://example.com/x', format: 'markdown' });
  const attempt = result.attempts[0]!;
  assert.equal(attempt.statusCode, undefined);
  assert.equal(attempt.apiStatus, 503);
  assert.equal(attempt.outcome, 'provider-error');
});

// --- formats and content ----------------------------------------------------------------------

test('format capability is preflighted: a Markdown-only provider is skipped without a request', async () => {
  const config = pageConfig(page => {
    page.providerId = 'exa';
    page.routes = [routeOf(page, 'provider'), routeOf(page, 'http'), routeOf(page, 'browser')];
    routeOf(page, 'provider').enabled = true;
  });
  const provider = fakeProvider([exaMarkdown('must not be requested')]);
  const { fetcher } = fakeFetch(() => htmlResponse('<html><body><p>original html</p></body></html>'));
  const result = await engineFor(config, { fetcher, providerCall: provider.call }).fetchPage({ url: 'https://example.com', format: 'html' });
  assert.equal(provider.calls.length, 0, 'no request is sent to a provider that cannot serve HTML');
  assert.equal(result.attempts[0]!.outcome, 'unsupported-format');
  assert.equal(result.ok, true);
  assert.equal(result.contentRoute, 'http');
  assert.match(result.content ?? '', /<p>original html<\/p>/, 'the HTTP route serves the requested HTML format');
});

test('native provider Markdown is returned verbatim, never reconverted', async () => {
  const native = '# Title\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```';
  const config = pageConfig(page => {
    page.providerId = 'exa';
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'provider').enabled = true;
  });
  const provider = fakeProvider([exaMarkdown(native)]);
  const result = await engineFor(config, { providerCall: provider.call }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(result.ok, true);
  assert.equal(result.content, native);
  assert.equal(result.representation, 'provider-markdown');
});

test('HTML is converted to Markdown with links resolved, tables kept and non-content removed', () => {
  const html = `<html><head><title>Doc</title><style>.x{}</style></head><body>
    <h2>Heading</h2><a href="/relative/page">link</a>
    <script>alert('never in markdown')</script>
    <div hidden>hidden text</div>
    <div style="display: none">also hidden</div>
    <table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
    <pre><code class="language-js">const x = 1;</code></pre>
    <img src="data:image/png;base64,AAAA" alt="dropped">
  </body></html>`;
  const parsed = parseHtmlDocument(html, 'https://example.com/docs/page');
  assert.equal(parsed.title, 'Doc');
  assert.doesNotMatch(parsed.text, /never in markdown|hidden text|also hidden/, 'non-content and hidden nodes are excluded from text');
  const markdown = htmlToMarkdown(parsed.cleanedHtml);
  assert.match(markdown, /## Heading/);
  assert.match(markdown, /\(https:\/\/example\.com\/relative\/page\)/, 'relative links resolve against the final URL');
  assert.match(markdown, /\| a\s*\|\s*b\s*\|/, 'GFM tables survive');
  assert.match(markdown, /```/);
  assert.match(markdown, /const x = 1;/);
  assert.doesNotMatch(markdown, /never in markdown/);
});

test('a plain-text page serves Markdown as text and cannot pretend to be page HTML', async () => {
  const markdownConfig = pageConfig();
  const { fetcher } = fakeFetch(() => htmlResponse('plain text body', 200, 'text/plain; charset=utf-8'));
  const result = await engineFor(markdownConfig, { fetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(result.ok, true);
  assert.equal(result.content, 'plain text body');
  assert.equal(result.representation, 'response-text');

  const htmlConfig = pageConfig();
  const { fetcher: htmlFetcher } = fakeFetch(() => htmlResponse('plain text body', 200, 'text/plain'));
  const htmlResult = await engineFor(htmlConfig, { fetcher: htmlFetcher }).fetchPage({ url: 'https://example.com', format: 'html' });
  assert.equal(htmlResult.ok, false);
  assert.equal(htmlResult.attempts[0]!.outcome, 'unsupported-content');
});

test('binary downloads and PDFs are refused with an unsupported-content result', async () => {
  const { fetcher } = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/pdf' } }));
  const result = await engineFor(pageConfig(), { fetcher }).fetchPage({ url: 'https://example.com/file.pdf', format: 'markdown' });
  assert.equal(result.ok, false);
  assert.equal(result.attempts[0]!.outcome, 'unsupported-content');
});

test('output truncation is reported separately from an acquisition limit', async () => {
  const truncated = pageConfig(page => {
    page.maxOutputChars = 40;
  });
  const { fetcher } = fakeFetch(() => htmlResponse(`<html><body>${'x'.repeat(500)}</body></html>`));
  const result = await engineFor(truncated, { fetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.content!.length, 40);
  assert.ok(result.notes.some(note => /output limit/.test(note)));

  const limited = pageConfig(page => {
    page.maxBodyBytes = 120;
  });
  const { fetcher: bigFetcher, calls } = fakeFetch(() => htmlResponse(`<html><body>${'y'.repeat(1000)}</body></html>`));
  const limitedResult = await engineFor(limited, { fetcher: bigFetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(limitedResult.ok, false);
  assert.equal(limitedResult.stopReason, 'limit');
  assert.equal(calls.length, 1, 'an acquisition limit is fatal and does not try another route');
});

test('the last acquired page is preserved once when a later route has a network failure', async () => {
  const config = pageConfig(page => {
    routeOf(page, 'http').rules = [structuredClone(CLOUDFLARE_CHALLENGE_PRESET)];
    routeOf(page, 'browser').enabled = true;
    routeOf(page, 'browser').rules = DEFAULT_FALLBACK_RULES;
    routeOf(page, 'provider').enabled = false;
  });
  const { fetcher } = fakeFetch(() => htmlResponse('<html><head><title>Just a moment...</title></head><body><script src="https://challenges.cloudflare.com/x.js"></script><p>challenge page</p></body></html>'));
  const failingBrowser = (async () => ({ outcome: 'network', error: { kind: 'network', message: 'browser transport down' }, notes: [] })) as BrowserFetcher;
  const result = await engineFor(config, { fetcher, browser: failingBrowser }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.contentRoute, 'http', 'provenance stays with the route that supplied the page');
  assert.equal(result.statusCode, 200);
  assert.match(result.content ?? '', /challenge page/);
  assert.equal(result.attempts[1]!.statusCode, undefined, 'the later failing route does not lend its metadata to the preserved page');
});

test('an exhausted chain with no page at all is not reported as success', async () => {
  const config = pageConfig(page => {
    routeOf(page, 'http').rules = DEFAULT_FALLBACK_RULES;
    routeOf(page, 'browser').enabled = true;
    routeOf(page, 'browser').rules = DEFAULT_FALLBACK_RULES;
  });
  const { fetcher } = fakeFetch(async () => {
    throw new TypeError('fetch failed');
  });
  const failingBrowser = (async () => ({ outcome: 'network', error: { kind: 'network', message: 'down' }, notes: [] })) as BrowserFetcher;
  const result = await engineFor(config, { fetcher, browser: failingBrowser }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.content, undefined);
  assert.equal(result.attempts.length, 2);
});

// --- timing, cancellation and fatal stops -----------------------------------------------------

test('a per-route timeout falls back, while caller cancellation and the overall deadline stop everything', async () => {
  const hanging = (async (_url: string, init: RequestInit) => {
    await new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
    throw new Error('unreachable');
  }) as typeof fetch;

  const fallbackConfig = pageConfig(page => {
    routeOf(page, 'http').timeoutMs = 40;
    routeOf(page, 'http').rules = DEFAULT_FALLBACK_RULES;
    routeOf(page, 'browser').enabled = true;
    routeOf(page, 'browser').rules = DEFAULT_FALLBACK_RULES;
  });
  const browser = fakeBrowser({ html: '<html><body>fallback page</body></html>' });
  const fallback = await engineFor(fallbackConfig, { fetcher: hanging, browser: browser.fetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.contentRoute, 'browser');
  assert.equal(fallback.attempts[0]!.outcome, 'timeout');

  const cancelledConfig = pageConfig(page => {
    routeOf(page, 'browser').enabled = true;
    routeOf(page, 'browser').rules = DEFAULT_FALLBACK_RULES;
  });
  const controller = new AbortController();
  const pending = engineFor(cancelledConfig, { fetcher: hanging, browser: fakeBrowser().fetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' }, controller.signal);
  setTimeout(() => controller.abort(), 20);
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.stopReason, 'cancelled');
  assert.equal(cancelled.attempts.length, 1, 'a caller abort is fatal and never reaches the next route');

  const deadlineConfig = pageConfig(page => {
    page.overallTimeoutMs = 40;
    routeOf(page, 'http').timeoutMs = 5_000;
    routeOf(page, 'browser').enabled = true;
    routeOf(page, 'browser').rules = DEFAULT_FALLBACK_RULES;
  });
  const deadline = await engineFor(deadlineConfig, { fetcher: hanging, browser: fakeBrowser().fetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(deadline.ok, false);
  assert.equal(deadline.stopReason, 'deadline');
});

test('enabling a browser route is the delegated decision, with no second switch to satisfy', async () => {
  const config = pageConfig(page => {
    routeOf(page, 'browser').enabled = true;
    routeOf(page, 'http').enabled = false;
  });
  config.browser.endpoint = 'ws://127.0.0.1:3030/ws';
  assert.equal('allowDelegatedFetching' in config.pageFetch, false, 'the retired switch is not part of a configuration');
  assert.deepEqual(validateConfig(config), [], 'an enabled browser route validates on its own');
  const browser = fakeBrowser();
  const result = await engineFor(config, { browser: browser.fetcher }).fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(result.ok, true, 'the route runs without a separate opt-in');
  assert.equal(result.contentRoute, 'browser');
  assert.ok(result.notes.some(note => /outside this process/.test(note)), 'the delegated trust boundary is still disclosed');
});

// --- target policy ----------------------------------------------------------------------------

test('local and private targets are refused before any request', async () => {
  const cases = ['http://127.0.0.1/admin', 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://localhost:8080/'];
  for (const url of cases) {
    const { fetcher, calls } = fakeFetch(() => htmlResponse('nope'));
    const result = await engineFor(pageConfig(), { fetcher }).fetchPage({ url, format: 'markdown' });
    assert.equal(result.ok, false, `${url} must be refused`);
    assert.equal(result.stopReason, 'policy');
    assert.equal(calls.length, 0);
  }
});

test('a public name that resolves to a private address is refused, and the opt-in allows it', async () => {
  const privateResolver = async () => ['93.184.216.34', '10.0.0.7'];
  const { fetcher, calls } = fakeFetch(() => htmlResponse('<html><body>internal</body></html>'));
  const refused = await engineFor(pageConfig(), { fetcher, resolver: privateResolver }).fetchPage({ url: 'https://internal.example.com/page', format: 'markdown' });
  assert.equal(refused.stopReason, 'policy');
  assert.equal(calls.length, 0);

  const allowedConfig = pageConfig(page => {
    page.allowPrivateNetworks = true;
  });
  const { fetcher: allowedFetcher, calls: allowedCalls } = fakeFetch(() => htmlResponse('<html><body>internal</body></html>'));
  const allowed = await engineFor(allowedConfig, { fetcher: allowedFetcher, resolver: privateResolver }).fetchPage({ url: 'https://internal.example.com/page', format: 'markdown' });
  assert.equal(allowed.ok, true);
  assert.equal(allowedCalls.length, 1);
});

test('redirects are followed manually, bounded, and re-checked against the policy', async () => {
  const chain: Record<string, Response> = {
    'https://example.com/start': new Response(null, { status: 302, headers: { location: '/middle' } }),
    'https://example.com/middle': new Response(null, { status: 302, headers: { location: 'https://other.example.com/final' } }),
    'https://other.example.com/final': htmlResponse('<html><body>final page</body></html>'),
  };
  const { fetcher, calls } = fakeFetch(url => chain[url] ?? htmlResponse('unexpected', 404));
  const followed = await engineFor(pageConfig(), { fetcher }).fetchPage({ url: 'https://example.com/start', format: 'markdown' });
  assert.equal(followed.ok, true);
  assert.equal(followed.finalUrl, 'https://other.example.com/final');
  assert.equal(calls.length, 3, 'each hop is a separate explicit request');

  const overLimit = pageConfig(page => {
    page.maxRedirects = 1;
  });
  const loop = fakeFetch(url => new Response(null, { status: 302, headers: { location: `${url}?again` } }));
  const limited = await engineFor(overLimit, { fetcher: loop.fetcher }).fetchPage({ url: 'https://example.com/start', format: 'markdown' });
  assert.equal(limited.ok, false);
  assert.equal(limited.stopReason, 'limit');
  assert.equal(loop.calls.length, 2, 'one request plus at most the configured redirects');

  const toPrivate = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }));
  const policy = await engineFor(pageConfig(), { fetcher: toPrivate.fetcher }).fetchPage({ url: 'https://example.com/start', format: 'markdown' });
  assert.equal(policy.stopReason, 'policy');
  assert.equal(toPrivate.calls.length, 1, 'the redirect target is refused before it is requested');
});

// --- browser transport ------------------------------------------------------------------------

test('the browser route captures the main document and cleans up everything it created', async () => {
  const browser = fakeBrowser({ html: '<html><head><title>Rendered</title></head><body><p>dom</p></body></html>', finalUrl: 'https://example.com/final' });
  const config = pageConfig(page => {
    page.browser.selectorWait = '#ready';
    page.browser.settleMs = 0;
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'browser').enabled = true;
  });
  config.browser.endpoint = 'ws://127.0.0.1:3030/ws';
  const result = await engineFor(config, { browser: browser.fetcher }).fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(result.ok, true);
  assert.equal(result.representation, 'rendered-dom');
  assert.equal(result.statusCode, 200);
  assert.match(result.content ?? '', /dom/);
  assert.deepEqual(browser.events.filter(event => event.startsWith('connect:') || event.endsWith('.close') || event.startsWith('browser.newContext')), [
    'connect:ws://127.0.0.1:3030/ws:{}',
    'browser.newContext:{"locale":"en-US","viewport":{"width":1280,"height":800}}',
    'page.close',
    'context.close',
    'browser.close',
  ]);
  assert.ok(!browser.events.some(event => /storageState/.test(event)), 'an isolated context carries no saved site login state');
  assert.ok(browser.events.some(event => event === 'page.waitForSelector:#ready'));
});

test('the browser route reuses the stored session only when asked, and closes on failure too', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'page-fetch-browser-'));
  const statePath = join(directory, 'state.json');
  writeFileSync(statePath, '{}');
  const browser = fakeBrowser({ html: '<html><body>session page</body></html>' });
  const config = pageConfig(page => {
    page.browser.context = 'session';
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'browser').enabled = true;
  });
  config.browser.endpoint = 'ws://127.0.0.1:3030/ws';
  config.browser.statePath = statePath;
  await engineFor(config, { browser: browser.fetcher }).fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.ok(browser.events.some(event => event.includes(`"storageState":"${statePath}"`)), 'session mode loads the configured state file');

  const failing = fakeBrowser({ failGoto: new Error('net::ERR_NAME_NOT_RESOLVED') });
  const failed = await engineFor(config, { browser: failing.fetcher }).fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(failed.ok, false);
  assert.equal(failed.attempts[0]!.outcome, 'network');
  assert.deepEqual(failing.events.filter(event => event.endsWith('.close')), ['page.close', 'context.close', 'browser.close'], 'a failure releases the page, context and connection');
  assert.ok(failed.notes.some(note => /resolved the target outside this process/.test(note)), 'the delegated trust boundary is disclosed');
});

test('a provider route discloses the same delegated trust boundary on success and on failure', async () => {
  const config = pageConfig(page => {
    page.providerId = 'exa';
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'provider').enabled = true;
  });
  const note = 'The provider resolved the target outside this process: the local public-only check cannot prove its destination.';

  const ok = await engineFor(config, { providerCall: fakeProvider([exaMarkdown('# Page\n\nbody')]).call }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(ok.ok, true);
  assert.equal(ok.contentRoute, 'provider');
  assert.ok(ok.notes.includes(note), 'a successful provider fetch says what the local policy could not prove');

  const failing = await engineFor(config, {
    providerCall: fakeProvider([() => { throw new Error('connect ECONNREFUSED 127.0.0.1'); }]).call,
  }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(failing.ok, false);
  assert.equal(failing.attempts[0]!.route, 'provider');
  assert.ok(failing.notes.includes(note), 'a failed provider fetch carries the same boundary');

  // The browser route says the same thing about its own actor, from one shared sentence.
  const browser = fakeBrowser({ failGoto: new Error('net::ERR_NAME_NOT_RESOLVED') });
  const browserRoute = await engineFor(pageConfig(page => {
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'browser').enabled = true;
  }), { browser: browser.fetcher }).fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.ok(browserRoute.notes.includes(note.replace('The provider', 'The browser')), 'the browser route keeps the same sentence with its own actor');
});

test('a browser route reports only the main-document status, so subresource failures cannot match a rule', async () => {
  const browser = fakeBrowser({ status: 200, html: '<html><body><img src="/missing.png"><p>ok</p></body></html>' });
  const config = pageConfig(page => {
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'browser').enabled = true;
    routeOf(page, 'browser').rules = [rule('subresource', { type: 'status', statuses: [404] })];
  });
  config.browser.endpoint = 'ws://127.0.0.1:3030/ws';
  const result = await engineFor(config, { browser: browser.fetcher }).fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(result.ok, true, 'a missing image is not a main-document failure');
  assert.deepEqual(result.attempts[0]!.rules, []);
});

test('browser cancellation releases the context and stops the chain', async () => {
  const config = pageConfig(page => {
    page.browser.settleMs = 1_000;
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'browser').enabled = true;
  });
  config.browser.endpoint = 'ws://127.0.0.1:3030/ws';
  const browser = fakeBrowser();
  const controller = new AbortController();
  const pending = engineFor(config, { browser: browser.fetcher }).fetchPage({ url: 'https://example.com/page', format: 'markdown' }, controller.signal);
  setTimeout(() => controller.abort(), 30);
  const result = await pending;
  assert.equal(result.stopReason, 'cancelled');
  assert.deepEqual(browser.events.filter(event => event.endsWith('.close')), ['page.close', 'context.close', 'browser.close']);
});

// --- configuration ----------------------------------------------------------------------------

test('an older saved configuration keeps its values and gains only the new fetch fields', () => {
  const saved = structuredClone(defaultConfig()) as unknown as Record<string, any>;
  delete saved.pageFetch;
  delete saved.tools.webExtract;
  for (const row of Object.values(saved.backends) as Array<Record<string, unknown>>) delete row.fetch;
  saved.backends.keenable.enabled = true;
  saved.backends.keenable.endpoint = 'https://custom.example.com/search';
  saved.backends.keenable.options.clientTitle = 'my-agent';
  saved.backends.keenable.mode = 'key';
  saved.browser.endpoint = 'ws://127.0.0.1:3000/ws';
  saved.diagnostics.maxEntries = 12;

  const loaded = parseConfig(saved);
  assert.equal(loaded.backends.keenable!.enabled, true);
  assert.equal(loaded.backends.keenable!.endpoint, 'https://custom.example.com/search');
  assert.equal(loaded.backends.keenable!.options.clientTitle, 'my-agent');
  assert.equal(loaded.backends.keenable!.mode, 'key');
  assert.equal(loaded.browser.endpoint, 'ws://127.0.0.1:3000/ws');
  assert.equal(loaded.diagnostics.maxEntries, 12);
  assert.equal(loaded.tools.webExtract, false, 'the new tool is opt-in');
  assert.equal(loaded.pageFetch.routes.length, 3);
  assert.deepEqual(loaded.pageFetch.routes.map(route => route.kind), ['http', 'browser', 'provider']);
  assert.deepEqual(loaded.pageFetch.routes.map(route => route.enabled), [true, false, false]);
  assert.deepEqual(validateConfig(loaded), []);
  assert.deepEqual(loaded.backends.exa!.fetch, defaultConfig().backends.exa!.fetch);
  assert.deepEqual(loaded.backends.keenable!.fetch, defaultConfig().backends.keenable!.fetch);
});

test('the retired delegated-fetching switch is dropped on load and an enabled route keeps working', () => {
  const saved = structuredClone(defaultConfig()) as unknown as Record<string, any>;
  // Exactly what an older release wrote: the record-and-enable switch next to the route it gated.
  saved.pageFetch.allowDelegatedFetching = true;
  saved.pageFetch.routes[1].enabled = true;
  saved.browser.endpoint = 'ws://127.0.0.1:3030/ws';
  const loaded = parseConfig(saved);
  assert.equal('allowDelegatedFetching' in loaded.pageFetch, false, 'the field is gone from the configuration');
  assert.equal(loaded.pageFetch.routes[1]!.enabled, true, 'an enabled browser route stays enabled');
  assert.deepEqual(validateConfig(loaded), [], 'the migrated configuration validates');
  // Dropping the switch changes nothing else: the same row without it loads to the same configuration.
  const withoutSwitch = structuredClone(saved);
  delete withoutSwitch.pageFetch.allowDelegatedFetching;
  assert.deepEqual(loaded, parseConfig(withoutSwitch));

  // A row that carried the switch but no longer needs it must not lose the safety switches beside it.
  const privateOn = structuredClone(saved);
  privateOn.pageFetch.allowPrivateNetworks = true;
  assert.equal(parseConfig(privateOn).pageFetch.allowPrivateNetworks, true);
});

test('saved rules and route order survive a load unchanged', () => {
  const saved = structuredClone(defaultConfig()) as unknown as Record<string, any>;
  const customRules = [rule('keep-me', { type: 'match', field: 'text', operator: 'equals', value: 'exact', caseSensitive: true })];
  saved.pageFetch.routes[0].rules = customRules;
  saved.pageFetch.routes = [saved.pageFetch.routes[2], saved.pageFetch.routes[0], saved.pageFetch.routes[1]];
  saved.pageFetch.routes[0].enabled = true;
  saved.pageFetch.providerId = 'exa';
  saved.tools.webExtract = true;
  const loaded = parseConfig(saved);
  assert.deepEqual(loaded.pageFetch.routes.map(route => route.kind), ['provider', 'http', 'browser']);
  assert.deepEqual(loaded.pageFetch.routes[1]!.rules, customRules, 'rules are not merged with defaults');
  assert.equal(loaded.tools.webExtract, true);
});

test('invalid new values fail validation instead of being reset', () => {
  const cases: Array<[string, (config: any) => void]> = [
    ['pageFetch.routes', config => { config.pageFetch.routes = config.pageFetch.routes.slice(0, 2); }],
    ['pageFetch.routes', config => { for (const route of config.pageFetch.routes) route.enabled = false; }],
    ['pageFetch.routes.0.rules.0.conditions.0', config => { config.pageFetch.routes[0].rules[0].conditions[0] = { type: 'api-status', statuses: [200] }; }],
    ['pageFetch.routes.0.rules.0.conditions.0.value', config => { config.pageFetch.routes[0].rules[0].conditions[0] = { type: 'match', field: 'text', operator: 'regex', value: '(?=x)', caseSensitive: true }; }],
    ['pageFetch.routes.0.rules', config => { config.pageFetch.routes[0].rules = Array.from({ length: 9 }, (_unused, index) => rule(`r${index}`, { type: 'network' })); }],
    ['pageFetch.routes.0.rules.0.conditions.0.statuses', config => { config.pageFetch.routes[0].rules[0].conditions[0] = { type: 'status', statuses: [99] }; }],
    ['pageFetch.routes.0.rules.0.extra', config => { config.pageFetch.routes[0].rules[0].extra = true; }],
    // Tavily now has a declared fetch operation, so a provider with none is what this case needs: a
    // search-only backend can never be selected for a page fetch.
    ['pageFetch.providerId', config => { config.pageFetch.providerId = 'brave'; config.pageFetch.routes[2].enabled = true; }],
    ['pageFetch.routes.1.enabled', config => { config.pageFetch.routes[1].enabled = true; }],
    // The retired delegated-fetching switch is not a field any more: a hand-edited file carrying it is
    // rejected, while `parseConfig()` drops it from an older save (see the migration test below).
    ['pageFetch.allowDelegatedFetching', config => { config.pageFetch.allowDelegatedFetching = true; }],
    // 'oauth' is a search access mode Exa never declared for fetching, so it is still refused.
    ['backends.exa.fetch.mode', config => { config.backends.exa.fetch.mode = 'oauth'; }],
    ['backends.exa.fetch.options.unknown', config => { config.backends.exa.fetch.options.unknown = 1; }],
    ['pageFetch.overallTimeoutMs', config => { config.pageFetch.overallTimeoutMs = 10; }],
  ];
  for (const [path, mutate] of cases) {
    const config = structuredClone(defaultConfig()) as unknown as Record<string, any>;
    mutate(config);
    const issues = validateConfig(config);
    assert.ok(issues.length > 0, `expected issues for ${path}`);
    assert.ok(issues.some(issue => issue.path === path), `expected an issue at ${path}, got ${issues.map(issue => issue.path).join(', ')}`);
  }
});

test('an explicitly invalid saved value is not replaced by a default', () => {
  const saved = structuredClone(defaultConfig()) as unknown as Record<string, any>;
  saved.pageFetch.overallTimeoutMs = 5;
  assert.throws(() => parseConfig(saved), /pageFetch.overallTimeoutMs/);
  const badBrowser = structuredClone(defaultConfig()) as unknown as Record<string, any>;
  badBrowser.browser.maxConcurrentReads = 0;
  assert.throws(() => parseConfig(badBrowser), /browser.maxConcurrentReads/);
});

test('catalog fetch metadata is declared only where it was verified', () => {
  const exa = defaultConfig().backends.exa!.fetch;
  assert.equal(exa.mode, 'anonymous');
  assert.equal(exa.endpoint, 'https://mcp.exa.ai/mcp');
  assert.equal(exa.options.maxCharacters, 50_000);
  const parallel = defaultConfig().backends.parallel!.fetch;
  assert.equal(parallel.options.full_content, true);
  assert.equal(parallel.endpoint, 'https://mcp.parallel.ai/mcp');
  // A declared fetch operation always produces a usable default record: the mode's own declared
  // fetch endpoint, even when that mode is not one of the provider's search modes.
  for (const definition of catalog) {
    const row = defaultConfig().backends[definition.id]!.fetch;
    if (!definition.fetch) {
      assert.equal(row.endpoint, '', `${definition.id}: a search-only provider has no fetch endpoint`);
      continue;
    }
    assert.ok(definition.fetch.modes.includes(row.mode), `${definition.id}: the default fetch mode is declared`);
    assert.match(row.endpoint, /^https?:\/\//, `${definition.id}: a fetch-capable provider has a default fetch endpoint`);
    assert.equal(row.endpoint, definition.fetch.endpoints?.[row.mode] ?? definition.modes.find(mode => mode.mode === row.mode)?.fetchEndpoint);
  }
  // A search-only provider keeps an inert record shaped like its first search mode.
  assert.equal(defaultConfig().backends.brave!.fetch.endpoint, '');
  assert.deepEqual(defaultConfig().backends.brave!.fetch.options, {});
});

test('the rule validator reports bounded, structured problems', () => {
  assert.deepEqual(validateRules(DEFAULT_FALLBACK_RULES, 'http', 'rules'), []);
  assert.deepEqual(validateRules([structuredClone(CLOUDFLARE_CHALLENGE_PRESET)], 'http', 'rules'), []);
  const tooMany = Array.from({ length: 9 }, (_unused, index) => rule(`r${index}`, { type: 'network' }));
  assert.ok(validateRules(tooMany, 'http', 'rules').some(issue => /At most 8 rules/.test(issue)));
  const missingConditions = [{ id: 'empty', enabled: true, conditions: [] }];
  assert.ok(validateRules(missingConditions, 'http', 'rules').some(issue => /at least one condition/i.test(issue)));
  const duplicate = [rule('same', { type: 'network' }), rule('same', { type: 'timeout' })];
  assert.ok(validateRules(duplicate, 'http', 'rules').some(issue => /unique/.test(issue)));
});


// --- connection binding and content sniffing --------------------------------------------------

test('the default transport resolves inside the socket lookup and refuses a private answer there', async () => {
  const seen: string[] = [];
  const lookup = createPinnedLookup({
    resolver: async hostname => {
      seen.push(hostname);
      return ['93.184.216.34'];
    },
    allowPrivateNetworks: false,
    onViolation: () => assert.fail('a public address must not violate the policy'),
  });
  const address = await new Promise((resolve, reject) => {
    (lookup as never as (host: string, options: unknown, callback: (error: unknown, value?: unknown) => void) => void)('example.com', {}, (error, value) => (error ? reject(error) : resolve(value)));
  });
  assert.equal(address, '93.184.216.34');
  assert.deepEqual(seen, ['example.com'], 'the address the socket uses is the address that was validated');

  const violations: string[] = [];
  const refusing = createPinnedLookup({ resolver: async () => ['10.0.0.5'], allowPrivateNetworks: false, onViolation: reason => violations.push(reason) });
  const error = await new Promise(resolve => {
    (refusing as never as (host: string, options: unknown, callback: (error: unknown) => void) => void)('rebound.example.com', {}, value => resolve(value));
  });
  assert.ok(error instanceof Error, 'the connection is refused at lookup time');
  assert.equal(violations.length, 1, 'the refusal is recorded so the route can report it as policy');

  const permissive = createPinnedLookup({ resolver: async () => ['10.0.0.5'], allowPrivateNetworks: true, onViolation: () => undefined });
  const allowed = await new Promise(resolve => {
    (permissive as never as (host: string, options: unknown, callback: (error: unknown, value?: unknown) => void) => void)('internal.example.com', {}, (_error, value) => resolve(value));
  });
  assert.equal(allowed, '10.0.0.5', 'the explicit private-network opt-in applies to the connection as well');
});

test('the HTTP route closes the transport it opened on every exit', async () => {
  const events: string[] = [];
  const transportFactory = () => ({
    request: async () => {
      events.push('request');
      return { status: 200, headers: new Headers({ 'content-type': 'text/html' }), body: new Response('<html><body><p>x</p></body></html>').body };
    },
    close: async () => {
      events.push('close');
    },
  });
  const result = await engineFor(pageConfig(), { transportFactory: transportFactory as never }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.equal(result.ok, true);
  assert.deepEqual(events, ['request', 'close']);
});

test('XML is text, not an HTML document to restructure', async () => {
  const xml = '<?xml version="1.0"?><root><item>value</item></root>';
  const { fetcher } = fakeFetch(() => htmlResponse(xml, 200, 'application/xml'));
  const asMarkdown = await engineFor(pageConfig(), { fetcher }).fetchPage({ url: 'https://example.com/data.xml', format: 'markdown' });
  assert.equal(asMarkdown.ok, true);
  assert.equal(asMarkdown.representation, 'response-text');
  assert.equal(asMarkdown.content, xml, 'XML is passed through as text instead of being parsed as HTML');

  const { fetcher: htmlFetcher } = fakeFetch(() => htmlResponse(xml, 200, 'application/xml'));
  const asHtml = await engineFor(pageConfig(), { fetcher: htmlFetcher }).fetchPage({ url: 'https://example.com/data.xml', format: 'html' });
  assert.equal(asHtml.ok, false);
  assert.equal(asHtml.attempts[0]!.outcome, 'unsupported-content');
});

test('an unknown declared type or undecodable body is refused instead of being read as Markdown', async () => {
  const { fetcher } = fakeFetch(() => htmlResponse('readable words', 200, 'application/vnd.acme.binary'));
  const unknown = await engineFor(pageConfig(), { fetcher }).fetchPage({ url: 'https://example.com/blob', format: 'markdown' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.attempts[0]!.outcome, 'unsupported-content');

  const { fetcher: untyped } = fakeFetch(() => new Response(new Uint8Array([0xff, 0xfe, 0x00, 0x01]), { status: 200 }));
  const binary = await engineFor(pageConfig(), { fetcher: untyped }).fetchPage({ url: 'https://example.com/blob', format: 'markdown' });
  assert.equal(binary.ok, false);
  assert.equal(binary.attempts[0]!.outcome, 'unsupported-content');

  const { fetcher: plainUntyped } = fakeFetch(() => new Response('plain words', { status: 200 }));
  const text = await engineFor(pageConfig(), { fetcher: plainUntyped }).fetchPage({ url: 'https://example.com/readme', format: 'markdown' });
  assert.equal(text.ok, true);
  assert.equal(text.content, 'plain words');
});


// --- default transport, end to end ----------------------------------------------------------

test('the default transport resolves inside the lookup, fetches a real local page and releases its agent', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<html><head><title>Local page</title></head><body><p>served locally</p></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const config = pageConfig(page => {
      page.allowPrivateNetworks = true;
    });
    // The host name goes through the pinned socket lookup and the system resolver; no injector
    // replaces either the transport or name resolution.
    const result = await createPageFetchEngine(config).fetchPage({ url: `http://localhost:${port}/local`, format: 'markdown' });
    assert.equal(result.ok, true);
    assert.equal(result.contentRoute, 'http');
    assert.match(result.content ?? '', /served locally/);
    assert.equal(result.attempts[0]!.statusCode, 200);

    // A target that does not answer must still settle and close, not hang the process.
    const refused = await createPageFetchEngine(defaultConfig()).fetchPage({ url: `http://localhost:${port}/`, format: 'markdown' });
    assert.equal(refused.stopReason, 'policy', 'the public-only default refuses a local target before connecting');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


// --- late-resource teardown, capture bounds and rule projections -------------------------------

test('an abort while the browser connection is still arriving closes the late connection', async () => {
  const browser = delayedBrowser({ step: 'connect', delayMs: 40 });
  const config = pageConfig(page => {
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'browser').enabled = true;
  });
  const controller = new AbortController();
  const started = Date.now();
  const pending = engineFor(config, { browser: browser.fetcher }).fetchPage({ url: 'https://example.com/page', format: 'markdown' }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  const result = await pending;
  assert.equal(result.stopReason, 'cancelled');
  assert.ok(Date.now() - started < 35, 'the fetch does not wait for the slow connect');
  assert.ok(!browser.events.includes('connect'), 'the connection had not arrived yet');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(browser.events.includes('connect'), 'the late connection did arrive');
  assert.deepEqual(browser.events.filter(event => event === 'browser.close'), ['browser.close'], 'the late connection is closed instead of leaked');
});

test('an abort while the context or page is being created closes the late resource', async () => {
  for (const step of ['context', 'page'] as const) {
    const browser = delayedBrowser({ step, delayMs: 40 });
    const config = pageConfig(page => {
      routeOf(page, 'http').enabled = false;
      routeOf(page, 'browser').enabled = true;
    });
    const controller = new AbortController();
    const pending = engineFor(config, { browser: browser.fetcher }).fetchPage({ url: 'https://example.com/page', format: 'markdown' }, controller.signal);
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    assert.equal(result.stopReason, 'cancelled', `${step}: abort wins`);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.ok(browser.events.includes('browser.close'), `${step}: the connection is closed`);
    if (step === 'context') assert.ok(browser.events.includes('context.close'), 'the late context is closed');
    if (step === 'page') assert.ok(browser.events.includes('page.close'), 'the late page is closed');
  }
});

test('a rendered document over the acquisition bound is a fatal limit, not a parsed page', async () => {
  const huge = `<html><body>${'x'.repeat(500)}</body></html>`;
  const browser = fakeBrowser({ html: huge });
  const config = pageConfig(page => {
    page.maxBodyBytes = 128;
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'browser').enabled = true;
  });
  const result = await engineFor(config, { browser: browser.fetcher }).fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'limit');
  assert.equal(result.content, undefined, 'nothing over the bound is returned as page content');
  assert.equal(result.attempts[0]!.outcome, 'limit');
  assert.deepEqual(browser.events.filter(event => event.endsWith('.close')), ['page.close', 'context.close', 'browser.close']);
});

test('Markdown is derived from the cleaned, link-resolved projection, not the raw response', async () => {
  const html = `<html><head><title>Doc</title></head><body>
    <script>var secret = 'script text';</script>
    <div hidden>hidden text</div>
    <p>visible words</p><a href="/relative/page">link</a>
    <table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
  </body></html>`;
  const { fetcher } = fakeFetch(() => htmlResponse(html));
  const result = await engineFor(pageConfig(), { fetcher }).fetchPage({ url: 'https://example.com/docs/page', format: 'markdown' });
  assert.equal(result.ok, true);
  assert.match(result.content ?? '', /visible words/);
  assert.match(result.content ?? '', /\(https:\/\/example\.com\/relative\/page\)/, 'relative links are resolved in the Markdown');
  assert.match(result.content ?? '', /\| a\s*\|\s*b\s*\|/, 'tables survive');
  assert.doesNotMatch(result.content ?? '', /script text|hidden text/, 'non-content and hidden nodes never reach the Markdown');
});

test('a markdown condition reads the converted projection for markdown, and is unavailable for html', async () => {
  const build = () => pageConfig(page => {
    routeOf(page, 'http').rules = [rule('md', { type: 'match', field: 'markdown', operator: 'contains', value: 'Example Domain', caseSensitive: false })];
  });
  const html = '<html><head><title>Example Domain</title></head><body><p>Example Domain body</p></body></html>';

  const markdownFetch = fakeFetch(() => htmlResponse(html));
  const markdownResult = await engineFor(build(), { fetcher: markdownFetch.fetcher }).fetchPage({ url: 'https://example.com', format: 'markdown' });
  assert.deepEqual(markdownResult.attempts[0]!.rules, ['md'], 'the converted Markdown is matchable');
  assert.ok(!markdownResult.attempts[0]!.unavailable.some(reason => reason.startsWith('markdown:')));
  assert.equal(markdownResult.stopReason, 'exhausted', 'a matched rule continues; there is no second route');

  const htmlFetch = fakeFetch(() => htmlResponse(html));
  const htmlResult = await engineFor(build(), { fetcher: htmlFetch.fetcher }).fetchPage({ url: 'https://example.com', format: 'html' });
  assert.equal(htmlResult.ok, true, 'with html output there is no Markdown to read, so no rule matches');
  assert.ok(htmlResult.attempts[0]!.unavailable.some(reason => reason.startsWith('markdown:')), 'the diagnostic says why');
});

test('the target policy decodes IPv4 carried inside IPv6, whatever notation reached it', async () => {
  const cases = [
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[0:0:0:0:0:ffff:7f00:1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[::127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
  ];
  for (const url of cases) {
    const { fetcher, calls } = fakeFetch(() => htmlResponse('nope'));
    const result = await engineFor(pageConfig(), { fetcher }).fetchPage({ url, format: 'markdown' });
    assert.equal(result.stopReason, 'policy', `${url} must be refused before any request`);
    assert.equal(calls.length, 0);
  }

  // The system resolver may hand back either notation; both must be checked.
  for (const address of ['::ffff:7f00:1', '::ffff:127.0.0.1', '64:ff9b::7f00:1']) {
    const { fetcher, calls } = fakeFetch(() => htmlResponse('nope'));
    const result = await engineFor(pageConfig(), { fetcher, resolver: async () => [address] }).fetchPage({ url: 'https://mapped.example.com/', format: 'markdown' });
    assert.equal(result.stopReason, 'policy', `resolver answer ${address} must be refused`);
    assert.equal(calls.length, 0);
  }

  // A public IPv4-mapped address stays allowed.
  const { fetcher } = fakeFetch(() => htmlResponse('<html><body>public</body></html>'));
  const publicResult = await engineFor(pageConfig(), { fetcher, resolver: async () => ['::ffff:5db8:d822'] }).fetchPage({ url: 'https://mapped.example.com/', format: 'markdown' });
  assert.equal(publicResult.ok, true, '::ffff:93.184.216.34 is public');
});


// --- malformed saved values ------------------------------------------------------------------

test('a route record that is null or a primitive is reported as a configuration issue, not a crash', () => {
  const shapes: unknown[][] = [[null], ['route'], [42], [{}, null], [null, null, null]];
  for (const routes of shapes) {
    const config = structuredClone(defaultConfig()) as unknown as Record<string, any>;
    config.pageFetch.routes = routes;
    const issues = validateConfig(config);
    assert.ok(issues.length > 0, `expected issues for ${JSON.stringify(routes)}`);
    assert.ok(issues.some(issue => issue.path === 'pageFetch.routes'), `expected the route path for ${JSON.stringify(routes)}, got ${issues.map(issue => issue.path).join(', ')}`);
    assert.throws(() => parseConfig(config), (error: unknown) => error instanceof Error && /pageFetch\.routes/.test(error.message) && !(error instanceof TypeError));
  }
});

// --- provider transport, end to end ---------------------------------------------------------

/** A real MCP server + client exchange over an injected fetcher: no wire mocking, no network. */
function providerFixture(toolName: string, toolResult: (args: Record<string, unknown>) => Record<string, unknown>, options: { failStatus?: number; keepOpen?: boolean } = {}) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'fixture', version: '1.0.0' }, {});
    server.registerTool(
      toolName,
      {
        description: 'fixture page fetch',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            urls: { type: 'array', items: { type: 'string' } },
            maxCharacters: { type: 'number' },
            full_content: { type: 'boolean' },
          },
        } as never),
      },
      async (args: unknown) => toolResult((args ?? {}) as Record<string, unknown>) as never,
    );
    return server;
  });
  // The test body is wrapped so the fixture can report how much the client actually pulled and
  // whether it cancelled: that is the observable proof of a bounded, early-stopped read.
  const state = { deliveredBytes: 0, cancelled: false };
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as Request).url);
    const body = typeof init?.body === 'string' ? init.body : '';
    if (options.failStatus !== undefined && body.includes('"tools/call"')) {
      return new Response('upstream unavailable', { status: options.failStatus });
    }
    const response = await handler.fetch(new Request(url, init));
    if (!response.body) return response;
    const reader = response.body.getReader();
    const tracked = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          if (!options.keepOpen) {
            controller.close();
            return;
          }
          // A real server may send the result and then keep the stream open for later messages.
          await new Promise(() => undefined);
          return;
        }
        state.deliveredBytes += value?.byteLength ?? 0;
        controller.enqueue(value);
      },
      cancel(reason) {
        state.cancelled = true;
        void reader.cancel(reason);
      },
    });
    return new Response(tracked, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
  return { fetcher, close: () => handler.close(), state };
}

const transportOptions = (): TransportOptions => ({
  retry: { enabled: false, statuses: [], maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0, networkErrors: false, timeouts: false },
  signal: new AbortController().signal,
  attemptTimeoutMs: 5_000,
  beforeAttempt: () => undefined,
  onAttempt: () => undefined,
});

const providerRequest = (providerId: string, tool: string, fetcher: typeof fetch, maxChars = 100_000): ProviderRouteRequest => ({
  providerId,
  url: 'https://example.com/page',
  format: 'markdown',
  transport: 'mcp',
  endpoint: 'https://fixture.local/mcp',
  tool,
  options: providerId === 'parallel' ? { full_content: true } : { maxCharacters: 50_000 },
  routeTimeoutMs: 5_000,
  signal: new AbortController().signal,
  maxChars,
  fetcher,
});

test('a tool-level provider error reaches the adapter with its API status intact', async () => {
  const fixture = providerFixture('web_fetch_exa', () => ({ content: [{ type: 'text', text: 'Error fetching URL(s): https://example.com/page: CRAWL_NOT_FOUND' }], isError: true }));
  try {
    const result = await fetchFromProvider(providerRequest('exa', 'web_fetch_exa', fixture.fetcher), callProviderTool);
    assert.equal(result.outcome, 'provider-error', 'the structured tool error is interpreted, not turned into a protocol failure');
    assert.equal(result.apiStatus, 200, 'the API status observed on the wire survives the tool error');
    assert.equal(result.statusCode, undefined, 'no target status is invented');
    assert.doesNotMatch(result.error!.message, /Error fetching URL|CRAWL_NOT_FOUND/, 'the provider body is not echoed');
    assert.ok(result.notes.some(note => /CRAWL_NOT_FOUND/.test(note)), 'the short provider code is kept as a note');
  } finally {
    await fixture.close();
  }
});

test('a provider API rejection keeps its HTTP status instead of becoming a bare protocol failure', async () => {
  const fixture = providerFixture('web_fetch_exa', () => ({ content: [{ type: 'text', text: 'ok' }] }), { failStatus: 503 });
  try {
    const result = await fetchFromProvider(providerRequest('exa', 'web_fetch_exa', fixture.fetcher), callProviderTool);
    assert.equal(result.outcome, 'provider-error');
    assert.equal(result.apiStatus, 503);
    assert.match(result.error!.message, /503/);
  } finally {
    await fixture.close();
  }
});

test('a successful provider response carries its structured content and API status', async () => {
  const fixture = providerFixture('web_fetch', () => ({
    structuredContent: { results: [{ url: 'https://example.com/final', title: 'Example', full_content: '# Page\n\nbody' }], errors: [] },
  }));
  try {
    const result = await fetchFromProvider(providerRequest('parallel', 'web_fetch', fixture.fetcher), callProviderTool);
    assert.equal(result.outcome, 'ok');
    assert.equal(result.markdown, '# Page\n\nbody');
    assert.equal(result.title, 'Example');
    assert.equal(result.finalUrl, 'https://example.com/final');
    assert.equal(result.apiStatus, 200);
  } finally {
    await fixture.close();
  }
});

test('a target 404 reported inside a provider response stays a target status', async () => {
  const fixture = providerFixture('web_fetch', () => ({
    structuredContent: { results: [], errors: [{ url: 'https://example.com/page', error_type: 'http_error', http_status_code: 404 }] },
  }));
  try {
    const result = await fetchFromProvider(providerRequest('parallel', 'web_fetch', fixture.fetcher), callProviderTool);
    assert.equal(result.outcome, 'http-error');
    assert.equal(result.statusCode, 404);
    assert.equal(result.apiStatus, 200);
  } finally {
    await fixture.close();
  }
});

test('a provider representation over the configured byte bound is a fatal limit in the adapter', async () => {
  const huge = `# Page\n\n${'x'.repeat(2_000)}`;
  const fixture = providerFixture('web_fetch_exa', () => ({ content: [{ type: 'text', text: huge }] }));
  try {
    // The configured bound is below the wire body, so the shared transport refuses it as a limit.
    const bounded = await fetchFromProvider(providerRequest('exa', 'web_fetch_exa', fixture.fetcher, 256), callProviderTool);
    assert.equal(bounded.outcome, 'limit');
    assert.equal(bounded.fatal, true);
    assert.equal(bounded.markdown, undefined);
  } finally {
    await fixture.close();
  }

  // A provider call injected by a host bypasses the wire, so the adapter applies the same bound.
  const injected = fakeProvider([exaMarkdown(huge)]);
  const config = pageConfig(page => {
    page.providerId = 'exa';
    page.maxBodyBytes = 256;
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'provider').enabled = true;
  });
  const result = await engineFor(config, { providerCall: injected.call }).fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'limit');
  assert.equal(result.content, undefined, 'nothing over the bound is returned as a page');
  assert.equal(result.attempts[0]!.outcome, 'limit');
  assert.equal(result.attempts.length, 1, 'a limit is fatal and never falls back');
});

test('the shared transport byte guard becomes a fatal limit on the fetch path, not a protocol error', async () => {
  const providerCall = async () => {
    throw new SearchError('protocol', 'Response exceeds the 4 MiB limit.', 200, 1);
  };
  const config = pageConfig(page => {
    page.providerId = 'exa';
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'provider').enabled = true;
  });
  const result = await engineFor(config, { providerCall: providerCall as never }).fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(result.stopReason, 'limit');
  assert.equal(result.ok, false);
  assert.equal(result.attempts[0]!.outcome, 'limit');
  assert.equal(result.attempts.length, 1, 'a limit never falls back');
});

// --- keyed REST fetch modes -------------------------------------------------------------------

/** A REST fetch request for one provider, as the engine builds it for a keyed access mode. */
const restRequest = (
  providerId: 'exa' | 'parallel',
  fetcher: typeof fetch,
  overrides: Partial<ProviderRouteRequest> = {},
): ProviderRouteRequest => ({
  providerId,
  url: 'https://example.com/page',
  format: 'markdown',
  transport: 'rest',
  endpoint: providerId === 'exa' ? 'https://api.exa.ai/contents' : 'https://api.parallel.ai/v1/extract',
  tool: providerId === 'exa' ? 'web_fetch_exa' : 'web_fetch',
  options: providerId === 'exa' ? { maxCharacters: 50_000 } : { full_content: true },
  routeTimeoutMs: 5_000,
  signal: new AbortController().signal,
  maxChars: 100_000,
  credential: 'stored-provider-key',
  fetcher,
  ...overrides,
});

/** A page-fetch config with one keyed provider route and no other route. */
function keyedFetchConfig(providerId: 'exa' | 'parallel', change: (config: SearchConfig) => void = () => undefined): SearchConfig {
  return pageConfig((_page, config) => {
    config.pageFetch.providerId = providerId;
    config.pageFetch.routes = [routeOf(config.pageFetch, 'provider')];
    routeOf(config.pageFetch, 'provider').enabled = true;
    // The mode switch resets the endpoint to the mode's own declared fetch endpoint; an empty saved
    // endpoint means "use that declared one".
    config.backends[providerId]!.fetch.mode = 'key';
    config.backends[providerId]!.fetch.endpoint = '';
    change(config);
  });
}

const exaContentsPayload = (native: string) => ({
  requestId: 'req_1',
  results: [{ url: 'https://example.com/final', title: 'Example Page', text: native }],
  statuses: [{ id: 'https://example.com/page', status: 'success', source: 'crawled' }],
});

const parallelExtractPayload = (native: string) => ({
  extract_id: 'extract_1',
  results: [{ url: 'https://example.com/final', title: 'Example Page', full_content: native, excerpts: ['an excerpt'] }],
  errors: [],
  session_id: 'session_1',
});

test('the keyed Exa mode posts the documented Contents request and takes its Markdown as native', async () => {
  const native = '# Title\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```';
  const { fetcher, calls } = fakeFetch(() => Response.json(exaContentsPayload(native)));
  const result = await fetchFromProvider(restRequest('exa', fetcher), callProviderTool);

  assert.equal(result.outcome, 'ok');
  assert.equal(result.markdown, native, 'results[0].text is returned verbatim, never reconverted');
  assert.equal(result.representation, 'provider-markdown');
  assert.equal(result.title, 'Example Page', 'results[0].title is captured when present');
  assert.equal(result.finalUrl, 'https://example.com/final');
  assert.equal(result.apiStatus, 200);

  const call = calls[0]!;
  assert.equal(call.url, 'https://api.exa.ai/contents');
  assert.equal(call.init.method, 'POST');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'stored-provider-key', 'the stored credential is the x-api-key header');
  assert.equal(headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(call.init.body)), { urls: ['https://example.com/page'], text: { maxCharacters: 50_000 } });
  assert.equal(calls.length, 1, 'one request, no retry and no second call');
  assert.ok(result.notes.some(note => /resolved the target outside this process/.test(note)), 'the REST path carries the delegated trust note');
});

test('the keyed Parallel mode posts the documented Extract request and takes its Markdown as native', async () => {
  const native = '# Title\n\nbody from extract';
  const { fetcher, calls } = fakeFetch(() => Response.json(parallelExtractPayload(native)));
  const result = await fetchFromProvider(restRequest('parallel', fetcher), callProviderTool);

  assert.equal(result.outcome, 'ok');
  assert.equal(result.markdown, native);
  assert.equal(result.title, 'Example Page');
  assert.equal(result.apiStatus, 200);

  const call = calls[0]!;
  assert.equal(call.url, 'https://api.parallel.ai/v1/extract', 'the GA Extract path, not the legacy v1beta one');
  assert.equal(call.init.method, 'POST');
  assert.equal((call.init.headers as Record<string,string>)['x-api-key'], 'stored-provider-key');
  assert.deepEqual(JSON.parse(String(call.init.body)), { urls: ['https://example.com/page'], advanced_settings: { full_content: true } });
});

test('both keyed modes keep the target error status apart from the provider API status', async () => {
  const exa = fakeFetch(() => Response.json({
    results: [],
    statuses: [{ id: 'https://example.com/page', status: 'error', error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404 } }],
  }));
  const exaResult = await fetchFromProvider(restRequest('exa', exa.fetcher), callProviderTool);
  assert.equal(exaResult.outcome, 'http-error');
  assert.equal(exaResult.statusCode, 404, 'the target status comes from statuses[0].error.httpStatusCode');
  assert.equal(exaResult.apiStatus, 200, 'the provider API itself answered 200 and stays separate');
  assert.ok(exaResult.notes.some(note => /CRAWL_NOT_FOUND/.test(note)), 'the machine code is kept as a note');
  assert.doesNotMatch(exaResult.error!.message, /CRAWL_NOT_FOUND/);

  const parallel = fakeFetch(() => Response.json({
    results: [],
    errors: [{ url: 'https://example.com/page', error_type: 'http_error', http_status_code: 500, content: 'upstream exploded' }],
  }));
  const parallelResult = await fetchFromProvider(restRequest('parallel', parallel.fetcher), callProviderTool);
  assert.equal(parallelResult.statusCode, 500);
  assert.equal(parallelResult.apiStatus, 200);
  assert.doesNotMatch(parallelResult.error!.message, /upstream exploded/, 'the provider error body is not echoed');
});

test('a keyed fetch API rejection maps 401/402/429 to their own kinds and never echoes the key or body', async () => {
  const cases: Array<[number, string, string]> = [
    [401, 'authentication', 'authentication'],
    [402, 'provider-error', 'provider'],
    [429, 'provider-error', 'provider'],
    [500, 'provider-error', 'provider'],
  ];
  for (const [status, outcome, kind] of cases) {
    const { fetcher, calls } = fakeFetch(() => new Response(`{"error":"the key stored-provider-key is wrong at ${status}"}`, { status, headers: { 'content-type': 'application/json' } }));
    const result = await fetchFromProvider(restRequest('exa', fetcher), callProviderTool);
    assert.equal(result.outcome, outcome, `HTTP ${status} maps to a ${outcome} outcome`);
    assert.equal(result.error?.kind, kind, `HTTP ${status} maps to a ${kind} failure kind`);
    assert.equal(result.apiStatus, status, 'the observed API status is preserved');
    assert.equal(result.statusCode, undefined, 'an API failure never invents a target status');
    const surfaced = JSON.stringify({ message: result.error?.message, notes: result.notes });
    assert.doesNotMatch(surfaced, /stored-provider-key/, 'the API key never reaches a message or a note');
    assert.doesNotMatch(surfaced, /is wrong at/, 'the provider error body is not echoed');
    assert.equal(calls.length, 1, 'an API rejection is never retried');
  }
});

test('a keyed mode without a stored key is an authentication failure before any request is built', async () => {
  for (const providerId of ['exa', 'parallel'] as const) {
    const { fetcher, calls } = fakeFetch(() => Response.json(exaContentsPayload('# never')));
    const result = await fetchFromProvider(restRequest(providerId, fetcher, { credential: undefined }), callProviderTool);
    assert.equal(result.outcome, 'authentication');
    assert.equal(result.error?.kind, 'authentication', 'a missing key is an operational authentication failure, not a provider reply');
    assert.equal(result.fatal, undefined, 'a missing key is never fatal, so a fallback rule may match it');
    assert.ok(result.notes.some(note => /missing/.test(note)), 'the note says the credential is missing');
    assert.doesNotMatch(JSON.stringify(result.notes), /key=|secret|Bearer/, 'no credential material is invented or echoed');
    assert.equal(calls.length, 0, `${providerId} sends nothing without a key`);
  }
});

test('an oversized keyed response is a fatal limit, not a partial page', async () => {
  const huge = Response.json(exaContentsPayload(`# Page\n\n${'x'.repeat(80_000)}`));
  const { fetcher } = fakeFetch(() => huge);
  const result = await fetchFromProvider(restRequest('exa', fetcher, { maxChars: 256 }), callProviderTool);
  assert.equal(result.outcome, 'limit');
  assert.equal(result.fatal, true);
  assert.equal(result.markdown, undefined);
});

test('a REST exchange never follows a redirect, and a refused one is a sanitized network failure', async () => {
  const { fetcher, calls } = fakeFetch(() => {
    throw new TypeError('fetch failed: unexpected redirect');
  });
  const result = await fetchFromProvider(restRequest('exa', fetcher), callProviderTool);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.init.redirect, 'error', 'a provider API redirect is never followed silently');
  assert.equal(result.outcome, 'network');
  assert.doesNotMatch(result.error!.message, /unexpected redirect/, 'the transport detail is not echoed');
});

test('a target failure is an HTTP error for both providers, whichever transport reported it', async () => {
  const payloads = {
    exa: () => Response.json({ results: [], statuses: [{ id: 'https://example.com/page', status: 'error', error: { tag: 'CRAWL_UNKNOWN', httpStatusCode: 503 } }] }),
    parallel: () => Response.json({ results: [], errors: [{ url: 'https://example.com/page', error_type: 'http_error', http_status_code: 503, content: null }] }),
  } as const;
  for (const providerId of ['exa', 'parallel'] as const) {
    const { fetcher } = fakeFetch(payloads[providerId]);
    const result = await fetchFromProvider(restRequest(providerId, fetcher), callProviderTool);
    assert.equal(result.outcome, 'http-error', `${providerId}: a reported target status of 503 is an HTTP failure`);
    assert.equal(result.error?.kind, 'http');
    assert.equal(result.statusCode, 503);
    assert.equal(result.apiStatus, 200, 'the provider API still answered 200');
  }

  // The keyless Parallel MCP tool carries the same document, so it classifies identically.
  const mcp = fakeProvider([() => ({ result: { structuredContent: { results: [], errors: [{ url: 'https://example.com/page', error_type: 'http_error', http_status_code: 503 }] } }, apiStatus: 200 })]);
  const mcpConfig = pageConfig(page => {
    page.providerId = 'parallel';
    page.routes = [routeOf(page, 'provider')];
    routeOf(page, 'provider').enabled = true;
  });
  const mcpResult = await engineFor(mcpConfig, { providerCall: mcp.call }).fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(mcpResult.attempts[0]!.outcome, 'http-error');
  assert.equal(mcpResult.attempts[0]!.statusCode, 503);
  assert.equal(mcpResult.attempts[0]!.apiStatus, 200);
});

test('one error:http fallback rule matches a target failure for both providers', async () => {
  const payloads = {
    exa: () => Response.json({ results: [], statuses: [{ id: 'https://example.com/page', status: 'error', error: { httpStatusCode: 403 } }] }),
    parallel: () => Response.json({ results: [], errors: [{ url: 'https://example.com/page', error_type: 'http_error', http_status_code: 403, content: null }] }),
  } as const;
  for (const providerId of ['exa', 'parallel'] as const) {
    const { fetcher, calls } = fakeFetch(url => (url === 'https://example.com/page' ? htmlResponse('<html><body><p>http fallback served this</p></body></html>') : payloads[providerId]()));
    const config = pageConfig((page, config) => {
      page.providerId = providerId;
      page.routes = [routeOf(page, 'provider'), routeOf(page, 'http')];
      for (const route of page.routes) route.enabled = true;
      routeOf(page, 'provider').rules = [rule('target-http', { type: 'error', kinds: ['http'] })];
      config.backends[providerId]!.fetch.mode = 'key';
      config.backends[providerId]!.fetch.endpoint = '';
    });
    const engine = createPageFetchEngine(config, { resolver: publicResolver, resolveCredential: async () => 'shared-search-key', fetcher, providerFetcher: fetcher });
    const result = await engine.fetchPage({ url: 'https://example.com/page', format: 'markdown' });
    assert.equal(result.ok, true, `${providerId}: the same error:http rule continues the chain`);
    assert.equal(result.contentRoute, 'http');
    assert.equal(result.attempts[0]!.outcome, 'http-error');
    assert.equal(result.attempts[0]!.statusCode, 403);
    assert.deepEqual(result.attempts[0]!.rules, ['target-http']);
    assert.equal(calls.length, 2, 'the provider call and the HTTP fallback, nothing else');
  }
});

test('a keyed response that is not the documented JSON document is a sanitized protocol failure', async () => {
  const { fetcher } = fakeFetch(() => new Response('sorry, not json', { status: 200, headers: { 'content-type': 'text/plain' } }));
  const result = await fetchFromProvider(restRequest('exa', fetcher), callProviderTool);
  assert.equal(result.outcome, 'protocol');
  assert.doesNotMatch(result.error!.message, /sorry, not json/);
});

test('both keyed modes reuse the provider search credential and the declared REST transport', async () => {
  const native = '# Keyed\n\nnative markdown';
  const payloads = { exa: exaContentsPayload(native), parallel: parallelExtractPayload(native) } as const;
  const endpoints = { exa: 'https://api.exa.ai/contents', parallel: 'https://api.parallel.ai/v1/extract' } as const;
  for (const providerId of ['exa', 'parallel'] as const) {
    const { fetcher, calls } = fakeFetch(() => Response.json(payloads[providerId]));
    const refs: string[] = [];
    const engine = createPageFetchEngine(keyedFetchConfig(providerId), {
      resolver: publicResolver,
      resolveCredential: async ref => { refs.push(ref); return 'shared-search-key'; },
      providerFetcher: fetcher,
    });
    const result = await engine.fetchPage({ url: 'https://example.com/page', format: 'markdown' });
    assert.equal(result.ok, true);
    assert.equal(result.content, native, `${providerId}: native provider Markdown is the page, not a conversion of it`);
    assert.equal(result.representation, 'provider-markdown');
    assert.equal(result.contentProvider, providerId);
    assert.equal(result.attempts[0]!.apiStatus, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, endpoints[providerId], `${providerId}: the keyed mode posts to its declared REST endpoint`);
    assert.equal((calls[0]!.init.headers as Record<string,string>)['x-api-key'], 'shared-search-key');
    assert.deepEqual(refs, [backendCredentialRef(providerId)], `${providerId}: one fixed credential reference is shared with search`);
  }
});

test('a keyed fetch with no stored key is a non-fatal authentication attempt that sends nothing', async () => {
  for (const providerId of ['exa', 'parallel'] as const) {
    const { fetcher, calls } = fakeFetch(() => Response.json(exaContentsPayload('# never')));
    const engine = createPageFetchEngine(keyedFetchConfig(providerId), {
      resolver: publicResolver,
      resolveCredential: async () => undefined,
      providerFetcher: fetcher,
    });
    const result = await engine.fetchPage({ url: 'https://example.com/page', format: 'markdown' });
    const attempt = result.attempts[0]!;
    assert.equal(attempt.outcome, 'authentication', `${providerId}: the missing key is an authentication outcome`);
    assert.equal(attempt.error?.kind, 'authentication');
    assert.equal(attempt.statusCode, undefined, 'no target status is invented');
    assert.equal(result.ok, false);
    assert.ok(result.notes.some(note => /credential is missing/.test(note)), 'the trace says the credential is missing');
    assert.ok(result.notes.some(note => /resolved the target outside this process/.test(note)), 'the delegated trust note is kept even when no request was sent');
    assert.equal(calls.length, 0, 'no request may be sent to learn what the configuration already says');
  }
});

test('a missing key matches an authentication fallback rule and the chain continues to the next route', async () => {
  for (const providerId of ['exa', 'parallel'] as const) {
    const { fetcher, calls } = fakeFetch(() => htmlResponse('<html><body><p>http fallback served this</p></body></html>'));
    // The provider route comes first; an authentication rule lets the HTTP route take over.
    const config = pageConfig((page, config) => {
      page.providerId = providerId;
      page.routes = [routeOf(page, 'provider'), routeOf(page, 'http')];
      for (const route of page.routes) route.enabled = true;
      routeOf(page, 'provider').rules = [rule('no-key', { type: 'error', kinds: ['authentication'] })];
      config.backends[providerId]!.fetch.mode = 'key';
      config.backends[providerId]!.fetch.endpoint = '';
    });
    const engine = createPageFetchEngine(config, { resolver: publicResolver, resolveCredential: async () => undefined, fetcher });
    const result = await engine.fetchPage({ url: 'https://example.com/page', format: 'markdown' });
    assert.equal(result.ok, true, `${providerId}: the chain falls back instead of failing`);
    assert.equal(result.contentRoute, 'http');
    assert.deepEqual(result.attempts.map(attempt => attempt.route), ['provider', 'http']);
    assert.equal(result.attempts[0]!.outcome, 'authentication');
    assert.deepEqual(result.attempts[0]!.rules, ['no-key'], 'the authentication rule matched');
    assert.equal(calls.length, 1, 'only the HTTP route sent a request');
    assert.equal(calls[0]!.url, 'https://example.com/page');
  }
});

test('a matched authentication rule with no later route is exhausted, not a hard failure', async () => {
  const { fetcher, calls } = fakeFetch(() => htmlResponse('<html><body>unused</body></html>'));
  const config = keyedFetchConfig('exa', config => {
    routeOf(config.pageFetch, 'provider').rules = [rule('no-key', { type: 'error', kinds: ['authentication'] })];
  });
  const engine = createPageFetchEngine(config, { resolver: publicResolver, resolveCredential: async () => undefined, providerFetcher: fetcher });
  const result = await engine.fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'exhausted', 'the rule matched and nothing else could serve the page');
  assert.equal(calls.length, 0);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]!.outcome, 'authentication');
});

test('without a matching rule the missing key simply stops the chain', async () => {
  const { fetcher, calls } = fakeFetch(() => htmlResponse('<html><body>unused</body></html>'));
  const config = keyedFetchConfig('exa', config => {
    // The default rules cover network errors and timeouts only, so authentication matches nothing.
    routeOf(config.pageFetch, 'provider').rules = DEFAULT_FALLBACK_RULES;
  });
  const engine = createPageFetchEngine(config, { resolver: publicResolver, resolveCredential: async () => undefined, providerFetcher: fetcher });
  const result = await engine.fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'stopped-on-error', 'no rule matched, so the chain stops on that error');
  assert.equal(result.attempts[0]!.outcome, 'authentication');
  assert.equal(calls.length, 0);
});

test('a keyed mode still preflights the format: HTML is skipped without a request', async () => {
  for (const providerId of ['exa', 'parallel'] as const) {
    const { fetcher, calls } = fakeFetch(() => Response.json(exaContentsPayload('# never')));
    const engine = createPageFetchEngine(keyedFetchConfig(providerId), {
      resolver: publicResolver,
      resolveCredential: async () => 'shared-search-key',
      providerFetcher: fetcher,
    });
    const result = await engine.fetchPage({ url: 'https://example.com/page', format: 'html' });
    assert.equal(result.stopReason, 'exhausted');
    assert.equal(result.attempts[0]!.outcome, 'unsupported-format');
    assert.equal(calls.length, 0, `${providerId} sends nothing for a format it cannot serve`);
  }
});

test('a key that is missing only for a route this call skips does not fail an HTML fetch', async () => {
  const { fetcher } = fakeFetch(() => htmlResponse('<html><body><p>http served this</p></body></html>'));
  for (const providerId of ['exa', 'parallel'] as const) {
    // The provider route comes first and the HTTP route still serves the page after the skip.
    const config = pageConfig((page, config) => {
      page.providerId = providerId;
      page.routes = [routeOf(page, 'provider'), routeOf(page, 'http')];
      for (const route of page.routes) route.enabled = true;
      config.backends[providerId]!.fetch.mode = 'key';
      config.backends[providerId]!.fetch.endpoint = '';
    });
    const engine = createPageFetchEngine(config, { resolver: publicResolver, resolveCredential: async () => undefined, fetcher });
    const result = await engine.fetchPage({ url: 'https://example.com/page', format: 'html' });
    assert.equal(result.ok, true, `${providerId}: a missing key does not affect a format the provider cannot serve`);
    assert.equal(result.contentRoute, 'http');
    assert.equal(result.attempts[0]!.outcome, 'unsupported-format', 'the provider route is skipped, not failed');
  }
});

test('the anonymous mode keeps the MCP transport: no REST request is made', async () => {
  const provider = fakeProvider([exaMarkdown('# MCP\n\nbody')]);
  const { fetcher, calls } = fakeFetch(() => Response.json(exaContentsPayload('# REST must not be used')));
  const config = pageConfig((page, config) => {
    page.providerId = 'exa';
    page.routes = [routeOf(page, 'provider')];
    routeOf(page, 'provider').enabled = true;
    config.backends.exa!.fetch.mode = 'anonymous';
  });
  const engine = createPageFetchEngine(config, { resolver: publicResolver, providerCall: provider.call, providerFetcher: fetcher });
  const result = await engine.fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(result.ok, true);
  assert.equal(result.content, '# MCP\n\nbody');
  assert.equal(provider.calls.length, 1);
  assert.equal((provider.calls[0] as { tool?: string }).tool, 'web_fetch_exa', 'the anonymous mode still calls its MCP tool');
  assert.equal((provider.calls[0] as { endpoint?: string }).endpoint, 'https://mcp.exa.ai/mcp');
  assert.equal(calls.length, 0, 'the REST path is never taken for an MCP mode');
});

test('the search path keeps its contract: a tool-level error is still a protocol failure', async () => {
  const fixture = providerFixture('web_fetch_exa', () => ({ content: [{ type: 'text', text: 'failed' }], isError: true }));
  try {
    await assert.rejects(
      callMcp('https://fixture.local/mcp', 'web_fetch_exa', { urls: ['https://example.com'] }, transportOptions(), { fetcher: fixture.fetcher }),
      (error: unknown) => error instanceof SearchError && error.kind === 'protocol',
      'returnErrorResult is opt-in, so search behaviour is unchanged',
    );
  } finally {
    await fixture.close();
  }
});


test('the browser capture bound counts UTF-8 bytes, remotely and as a local recheck', async () => {
  const multibyte = `<html><body>${'汉'.repeat(300)}</body></html>`;
  assert.equal(new TextEncoder().encode(multibyte).byteLength > 300, true);

  // 900 bytes, 300 characters: a character bound would let this through, a byte bound must not.
  const remote = fakeBrowser({ html: multibyte, capture: 'limit' });
  const remoteConfig = pageConfig(page => {
    page.maxBodyBytes = 512;
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'browser').enabled = true;
  });
  const remoteResult = await engineFor(remoteConfig, { browser: remote.fetcher }).fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(remoteResult.stopReason, 'limit');
  assert.equal(remoteResult.content, undefined);

  // A page context that returns the document anyway is still refused before any parse.
  const local = fakeBrowser({ html: multibyte, capture: 'ignore' });
  const localResult = await engineFor(remoteConfig, { browser: local.fetcher }).fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(localResult.stopReason, 'limit');
  assert.equal(localResult.content, undefined);
});

test('the provider acquisition bound counts UTF-8 bytes, not characters', async () => {
  // 800 characters, 2400 UTF-8 bytes: the configured bound is 1024 bytes, so this must be refused.
  const multibyte = '汉'.repeat(800);
  const injected = fakeProvider([exaMarkdown(multibyte)]);
  const config = pageConfig(page => {
    page.providerId = 'exa';
    page.maxBodyBytes = 1024;
    routeOf(page, 'http').enabled = false;
    routeOf(page, 'provider').enabled = true;
  });
  const result = await engineFor(config, { providerCall: injected.call }).fetchPage({ url: 'https://example.com/page', format: 'markdown' });
  assert.equal(result.stopReason, 'limit');
  assert.equal(result.ok, false);
  assert.equal(result.content, undefined);
  assert.equal(result.attempts.length, 1, 'a limit is fatal and never falls back');
});

test('utf8ByteLength measures the encoded size the bounds rely on', () => {
  assert.equal(utf8ByteLength('abc'), 3);
  assert.equal(utf8ByteLength('汉'), 3);
  assert.equal(utf8ByteLength('😀'), 4);
  assert.equal(utf8ByteLength('a汉😀'), 8);
});

test('the provider wire bound is the configured limit plus protocol headroom and stops the read early', async () => {
  // 120 KB of UTF-8 content against a 256-byte acquisition bound: the wire bound is
  // 256 + 64 KiB, so the read is cancelled mid-stream instead of parsing the whole body.
  const huge = '汉'.repeat(40_000);
  const fixture = providerFixture('web_fetch_exa', () => ({ content: [{ type: 'text', text: huge }] }));
  const state = fixture.state;
  try {
    const started = Date.now();
    const result = await fetchFromProvider(providerRequest('exa', 'web_fetch_exa', fixture.fetcher, 256), callProviderTool);
    const elapsed = Date.now() - started;
    assert.equal(result.outcome, 'limit');
    assert.equal(result.fatal, true);
    assert.equal(result.markdown, undefined);
    assert.ok(elapsed < 3_000, `the bound fails promptly instead of waiting for a client timeout (${elapsed}ms)`);
    // One upstream chunk can already be over the bound, so the observable proof is cancellation of
    // the response stream at that chunk, not a particular byte prefix.
    assert.equal(state.cancelled, true, 'the client cancels the upstream body at the bound');
  } finally {
    await fixture.close();
  }
});


test('a valid SSE result resolves without waiting for the stream to close', async () => {
  const fixture = providerFixture('web_fetch', () => ({
    structuredContent: { results: [{ url: 'https://example.com/final', title: 'Open Stream', full_content: '# Open\n\nstill streaming' }], errors: [] },
  }), { keepOpen: true });
  try {
    const request = { ...providerRequest('parallel', 'web_fetch', fixture.fetcher), routeTimeoutMs: 400 };
    const started = Date.now();
    const result = await fetchFromProvider(request, callProviderTool);
    const elapsed = Date.now() - started;
    assert.equal(result.outcome, 'ok', 'the response event ends the read even though the server keeps the stream open');
    assert.equal(result.markdown, '# Open\n\nstill streaming');
    assert.equal(result.title, 'Open Stream');
    assert.equal(result.apiStatus, 200, 'the observed API status is preserved');
    assert.ok(elapsed < 400, `the valid result is not turned into a route timeout (${elapsed}ms)`);
    assert.equal(fixture.state.cancelled, true, 'the remaining stream is cancelled once the result is complete');
  } finally {
    await fixture.close();
  }
});

test('an oversized SSE result is a prompt limit with the API status preserved', async () => {
  const huge = '汉'.repeat(40_000);
  const fixture = providerFixture('web_fetch_exa', () => ({ content: [{ type: 'text', text: huge }] }), { keepOpen: true });
  try {
    const started = Date.now();
    const result = await fetchFromProvider(providerRequest('exa', 'web_fetch_exa', fixture.fetcher, 256), callProviderTool);
    const elapsed = Date.now() - started;
    assert.equal(result.outcome, 'limit');
    assert.equal(result.fatal, true);
    assert.equal(result.apiStatus, 200, 'an oversized body is still an API success that hit a local bound');
    assert.equal(result.markdown, undefined);
    assert.ok(elapsed < 3_000, `the read stops at the bound (${elapsed}ms)`);
    assert.equal(fixture.state.cancelled, true);
  } finally {
    await fixture.close();
  }
});

test('a browser navigation failure keeps the driver code and drops everything else', async () => {
  const { createBrowserFetcher } = await import('../src/fetch/browser-route.js');
  const failing = createBrowserFetcher(async () => {
    const browser = {
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => { throw new Error('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com/secret?token=abc\nCall log: navigating'); },
          close: async () => undefined,
        }),
        close: async () => undefined,
      }),
      close: async () => undefined,
    };
    return browser as never;
  });
  const result = await failing({
    url: new URL('https://example.com'),
    format: 'markdown',
    routeTimeoutMs: 5_000,
    settleMs: 0,
    selectorWait: '',
    contextMode: 'isolated',
    endpoint: 'ws://127.0.0.1:3030/ws',
    maxBodyBytes: 1_000_000,
    signal: new AbortController().signal,
  });
  assert.equal(result.outcome, 'network');
  assert.match(result.error?.message ?? '', /net::ERR_TUNNEL_CONNECTION_FAILED/);
  assert.doesNotMatch(result.error?.message ?? '', /example\.com|token=abc|Call log/);
});

test('a navigation failure without a driver code reads the same as before', async () => {
  const { createBrowserFetcher } = await import('../src/fetch/browser-route.js');
  const failing = createBrowserFetcher(async () => ({
    newContext: async () => ({
      newPage: async () => ({ goto: async () => { throw new Error('something odd happened'); }, close: async () => undefined }),
      close: async () => undefined,
    }),
    close: async () => undefined,
  }) as never);
  const result = await failing({
    url: new URL('https://example.com'),
    format: 'markdown',
    routeTimeoutMs: 5_000,
    settleMs: 0,
    selectorWait: '',
    contextMode: 'isolated',
    endpoint: 'ws://127.0.0.1:3030/ws',
    maxBodyBytes: 1_000_000,
    signal: new AbortController().signal,
  });
  assert.match(result.error?.message ?? '', /^The browser could not load the target page \(something odd happened\)\.$/);
});

test('a document that navigates while it is being read is read once more, not failed', async () => {
  const { createBrowserFetcher } = await import('../src/fetch/browser-route.js');
  let reads = 0;
  const fetcher = createBrowserFetcher(async () => ({
    newContext: async () => ({
      newPage: async () => ({
        goto: async () => ({ status: () => 200 }),
        url: () => 'https://example.com/',
        waitForLoadState: async () => undefined,
        evaluate: async () => {
          reads += 1;
          if (reads === 1) throw new Error('Execution context was destroyed, most likely because of a navigation');
          return { html: '<html><head><title>settled</title></head><body>ok</body></html>' };
        },
        close: async () => undefined,
      }),
      close: async () => undefined,
    }),
    close: async () => undefined,
  }) as never);
  const result = await fetcher({
    url: new URL('https://example.com'),
    format: 'markdown',
    routeTimeoutMs: 5_000,
    settleMs: 0,
    selectorWait: '',
    contextMode: 'isolated',
    endpoint: 'ws://127.0.0.1:3030/ws',
    maxBodyBytes: 1_000_000,
    signal: new AbortController().signal,
  });
  assert.equal(reads, 2, 'the read was attempted exactly twice');
  assert.equal(result.outcome, 'ok');
  assert.match(result.html ?? '', /ok/);
});

test('a failure after the response keeps the status the target already answered', async () => {
  const { createBrowserFetcher } = await import('../src/fetch/browser-route.js');
  const fetcher = createBrowserFetcher(async () => ({
    newContext: async () => ({
      newPage: async () => ({
        goto: async () => ({ status: () => 403 }),
        url: () => 'https://www.zhihu.com/signin',
        waitForLoadState: async () => undefined,
        evaluate: async () => { throw new Error('Target page, context or browser has been closed'); },
        close: async () => undefined,
      }),
      close: async () => undefined,
    }),
    close: async () => undefined,
  }) as never);
  const result = await fetcher({
    url: new URL('https://www.zhihu.com/question/1'),
    format: 'markdown',
    routeTimeoutMs: 5_000,
    settleMs: 0,
    selectorWait: '',
    contextMode: 'isolated',
    endpoint: 'ws://127.0.0.1:3030/ws',
    maxBodyBytes: 1_000_000,
    signal: new AbortController().signal,
  });
  assert.equal(result.outcome, 'network');
  assert.equal(result.statusCode, 403, 'the observed status survives the later failure');
  assert.equal(result.finalUrl, 'https://www.zhihu.com/signin');
  assert.match(result.error?.message ?? '', /answered HTTP 403 before the read failed/);
});

test('a rendered page behind a 4xx is asked for once more, and the second answer decides', async () => {
  const { createBrowserFetcher } = await import('../src/fetch/browser-route.js');
  const statuses: (number | undefined)[] = [];
  let loads = 0;
  const page = {
    goto: async () => { loads += 1; const status = loads === 1 ? 403 : 200; statuses.push(status); return { status: () => status }; },
    url: () => 'https://www.zhihu.com/question/1',
    waitForLoadState: async () => undefined,
    evaluate: async () => ({ html: '<html><head><title>Real page</title></head><body>' + 'answer text '.repeat(60) + '</body></html>' }),
    close: async () => undefined,
  };
  const fetcher = createBrowserFetcher(async () => ({
    newContext: async () => ({ newPage: async () => page, close: async () => undefined }),
    close: async () => undefined,
  }) as never);
  const result = await fetcher({
    url: new URL('https://www.zhihu.com/question/1'),
    format: 'markdown',
    routeTimeoutMs: 5_000,
    settleMs: 0,
    selectorWait: '',
    contextMode: 'session',
    endpoint: 'ws://127.0.0.1:3030/ws',
    maxBodyBytes: 1_000_000,
    signal: new AbortController().signal,
  });
  assert.equal(loads, 2, 'the navigation was retried exactly once');
  assert.equal(result.outcome, 'ok', 'the 200 answered by the retry is the outcome');
  assert.equal(result.statusCode, 200);
  assert.ok(result.notes.some(note => /answered HTTP 403; it rendered a page/.test(note)), 'the first refusal stays in the record');
});

test('a bare 4xx page is not retried, so a real 404 still stops the chain', async () => {
  const { createBrowserFetcher } = await import('../src/fetch/browser-route.js');
  let loads = 0;
  const page = {
    goto: async () => { loads += 1; return { status: () => 404 }; },
    url: () => 'https://example.com/missing',
    waitForLoadState: async () => undefined,
    evaluate: async () => ({ html: '<html><head><title></title></head><body>not found</body></html>' }),
    close: async () => undefined,
  };
  const fetcher = createBrowserFetcher(async () => ({
    newContext: async () => ({ newPage: async () => page, close: async () => undefined }),
    close: async () => undefined,
  }) as never);
  const result = await fetcher({
    url: new URL('https://example.com/missing'),
    format: 'markdown',
    routeTimeoutMs: 5_000,
    settleMs: 0,
    selectorWait: '',
    contextMode: 'isolated',
    endpoint: 'ws://127.0.0.1:3030/ws',
    maxBodyBytes: 1_000_000,
    signal: new AbortController().signal,
  });
  assert.equal(loads, 1, 'a bare 404 is reported, not retried');
  assert.equal(result.outcome, 'http-error');
  assert.equal(result.statusCode, 404);
});

test('session mode with no configured path reads the standard session file, isolated mode never does', async () => {
  const { createBrowserFetcher } = await import('../src/fetch/browser-route.js');
  const seen: (string | undefined)[] = [];
  const make = (capture: (value: string | undefined) => void) => createBrowserFetcher(async () => ({
    newContext: async (options: { storageState?: unknown }) => {
      capture(typeof options.storageState === 'string' ? options.storageState : undefined);
      return {
        newPage: async () => ({
          goto: async () => ({ status: () => 200 }),
          url: () => 'https://example.com/',
          evaluate: async () => ({ html: '<html><head><title>t</title></head><body>ok</body></html>' }),
          close: async () => undefined,
        }),
        close: async () => undefined,
      };
    },
    close: async () => undefined,
  }) as never);
  const request = {
    url: new URL('https://example.com'),
    format: 'markdown' as const,
    routeTimeoutMs: 5_000,
    settleMs: 0,
    selectorWait: '',
    endpoint: 'ws://127.0.0.1:3030/ws',
    maxBodyBytes: 1_000_000,
    signal: new AbortController().signal,
  };
  await make(value => seen.push(value))({ ...request, contextMode: 'session' as const });
  await make(value => seen.push(value))({ ...request, contextMode: 'isolated' as const });
  assert.equal(seen.length, 2);
  assert.match(String(seen[0] ?? ''), /dsh-search\/browser\/state\.json$/, 'session mode defaults to the standard file');
  assert.equal(seen[1], undefined, 'isolated mode reads no session file');
});
