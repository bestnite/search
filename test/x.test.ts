import test from 'node:test';
import assert from 'node:assert/strict';
import { searchX } from '../src/x/index.js';
import { API_MAX_RESULTS, API_MIN_RESULTS, OFFICIAL_SEARCH_URL } from '../src/x/official.js';
import { SearchError } from '../src/transport.js';

type Call = { url: URL; headers: Record<string, string> };

function mockFetch(responder: (call: Call) => { status?: number; body?: unknown; text?: string }) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof URL ? input : input instanceof Request ? input.url : input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    const out = responder({ url, headers });
    const text = out.text ?? JSON.stringify(out.body ?? {});
    return new Response(text, { status: out.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const searchBody = (count: number) => ({
  data: Array.from({ length: count }, (_, index) => ({
    id: `10${index}`,
    text: `post number ${index}\nwith a newline`,
    author_id: '42',
    created_at: '2026-11-17T08:00:00.000Z',
    public_metrics: { like_count: 7, repost_count: 2, reply_count: 1, quote_count: 0, bookmark_count: 0, impression_count: 100 },
  })),
  includes: { users: [{ id: '42', username: 'bestnite' }] },
  meta: { result_count: count },
});

const ctx = (fetcher: typeof fetch, mode: 'key' | 'session' = 'key', extra: Record<string, unknown> = {}) => ({
  mode,
  credentials: mode === 'key' ? { bearerToken: 'secret-bearer' } : { authToken: 'secret-auth', ct0: 'secret-ct0' },
  signal: new AbortController().signal,
  timeoutMs: 5000,
  fetch: fetcher,
  ...extra,
});

test('bearer mode hits the official endpoint with the token and expands authors', async () => {
  const { fetcher, calls } = mockFetch(() => ({ body: searchBody(10) }));
  const sources = await searchX({ query: 'deepseek harness', maxResults: 10 }, ctx(fetcher));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url.origin + calls[0]!.url.pathname, OFFICIAL_SEARCH_URL);
  assert.equal(calls[0]!.headers.Authorization, 'Bearer secret-bearer');
  assert.equal(calls[0]!.url.searchParams.get('query'), 'deepseek harness');
  assert.match(String(calls[0]!.url.searchParams.get('tweet.fields')), /created_at/);
  assert.equal(calls[0]!.url.searchParams.get('expansions'), 'author_id');
  assert.equal(sources.length, 10);
  assert.equal(sources[0]!.url, 'https://x.com/bestnite/status/100');
  assert.equal(sources[0]!.publishedAt, '2026-11-17T08:00:00.000Z');
  assert.doesNotMatch(sources[0]!.snippet!, /\n/);
  assert.match(sources[0]!.summary!, /7 likes/);
});

test('the request is never sized outside the API bounds', async () => {
  const small = mockFetch(() => ({ body: searchBody(2) }));
  await searchX({ query: 'q', maxResults: 2 }, ctx(small.fetcher));
  assert.equal(small.calls[0]!.url.searchParams.get('max_results'), String(API_MIN_RESULTS));

  const huge = mockFetch(() => ({ body: searchBody(1) }));
  await searchX({ query: 'q', maxResults: 500 }, ctx(huge.fetcher, 'key', { postsPerSearch: 500 }));
  assert.equal(huge.calls[0]!.url.searchParams.get('max_results'), String(API_MAX_RESULTS));

  const capped = mockFetch(() => ({ body: searchBody(1) }));
  await searchX({ query: 'q', maxResults: 100 }, ctx(capped.fetcher, 'key', { postsPerSearch: 20 }));
  assert.equal(capped.calls[0]!.url.searchParams.get('max_results'), '20');
});

test('the posts-per-search cap truncates what the caller gets back', async () => {
  const { fetcher } = mockFetch(() => ({ body: searchBody(10) }));
  const sources = await searchX({ query: 'q', maxResults: 10 }, ctx(fetcher, 'key', { postsPerSearch: 4 }));
  assert.equal(sources.length, 4);
});

test('rejected tokens and rate limits are reported as distinct failures', async () => {
  for (const [status, kind] of [[401, 'authentication'], [403, 'authentication'], [429, 'rate-limit'], [400, 'configuration'], [502, 'http']] as const) {
    const { fetcher } = mockFetch(() => ({ status, body: { title: 'error', detail: 'secret-bearer leaked?' } }));
    await assert.rejects(searchX({ query: 'q', maxResults: 10 }, ctx(fetcher)), (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.kind, kind);
      assert.doesNotMatch(error.message, /secret-bearer/);
      assert.doesNotMatch(error.message, /leaked/);
      return true;
    });
  }
});

test('unknown payloads fail as protocol errors instead of returning nothing', async () => {
  const { fetcher } = mockFetch(() => ({ body: { nonsense: true } }));
  await assert.rejects(searchX({ query: 'q', maxResults: 10 }, ctx(fetcher)), (error: unknown) => error instanceof SearchError && error.kind === 'protocol');
});

test('a missing credential fails before any request is sent', async () => {
  const { fetcher, calls } = mockFetch(() => ({ body: searchBody(1) }));
  await assert.rejects(searchX({ query: 'q', maxResults: 10 }, { mode: 'key', credentials: {}, signal: new AbortController().signal, timeoutMs: 1000, fetch: fetcher }),
    (error: unknown) => error instanceof SearchError && error.kind === 'configuration');
  await assert.rejects(searchX({ query: 'q', maxResults: 10 }, { mode: 'session', credentials: { authToken: 'only-one' }, signal: new AbortController().signal, timeoutMs: 1000, fetch: fetcher }),
    (error: unknown) => error instanceof SearchError && error.kind === 'configuration');
  assert.equal(calls.length, 0);
});

test('network failures and cancellation map to network and timeout', async () => {
  const failing = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
  await assert.rejects(searchX({ query: 'q', maxResults: 10 }, ctx(failing)), (error: unknown) => error instanceof SearchError && error.kind === 'network');
  const controller = new AbortController();
  controller.abort();
  const slow = (async () => { throw new Error('aborted'); }) as unknown as typeof fetch;
  await assert.rejects(searchX({ query: 'q', maxResults: 10 }, { ...ctx(slow), signal: controller.signal }), (error: unknown) => error instanceof SearchError && error.kind === 'timeout');
});
