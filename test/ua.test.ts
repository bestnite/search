import test from 'node:test';
import assert from 'node:assert/strict';
import { appUserAgent, initWithAppUserAgent, setUserAgent, withAppUserAgent } from '../src/ua.js';
import { requestText } from '../src/transport.js';
import { searchX } from '../src/x/index.js';

const capture = () => {
  const seen: Array<Record<string, string>> = [];
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push(headers);
    return new Response(JSON.stringify({ data: [], meta: { result_count: 0 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
};

const options = (fetcher: typeof fetch) => ({ retry: { enabled: false, statuses: [500], maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } as never, signal: new AbortController().signal, attemptTimeoutMs: 1000, beforeAttempt: () => { }, onAttempt: () => { }, fetch: fetcher });

test('every transport request carries the caller identity', async () => {
  const { fetcher, seen } = capture();
  await requestText('https://example.test/api', { method: 'GET' }, options(fetcher));
  assert.equal(seen[0]!['User-Agent'], appUserAgent());
  assert.match(appUserAgent(), /^[a-z-]+\/\S+ \(\+https:\/\/\S+\)$/);
});

test('a caller that already chose a User-Agent keeps it', async () => {
  const { fetcher, seen } = capture();
  await requestText('https://example.test/api', { method: 'GET', headers: { 'user-agent': 'impersonated/1.0' } }, options(fetcher));
  assert.equal(seen[0]!['user-agent'], 'impersonated/1.0');
  assert.equal(seen[0]!['User-Agent'], undefined);
});

test('header containers of every shape are handled', async () => {
  const headered = initWithAppUserAgent({ headers: new Headers({ 'X-Test': '1' }) });
  assert.equal((headered.headers as Headers).get('User-Agent'), appUserAgent());
  const tuples = initWithAppUserAgent({ headers: [['X-Test', '1']] });
  assert.deepEqual(tuples.headers, [['X-Test', '1'], ['User-Agent', appUserAgent()]]);
  const object = withAppUserAgent({ Accept: 'application/json' });
  assert.equal(object['User-Agent'], appUserAgent());
});

test('the official X request identifies itself, the impersonating paths do not', async () => {
  const { fetcher, seen } = capture();
  await searchX({ query: 'q', maxResults: 10 }, { mode: 'key', credentials: { bearerToken: 't' }, signal: new AbortController().signal, timeoutMs: 1000, fetch: fetcher });
  assert.equal(seen[0]!['User-Agent'], appUserAgent());
});

test('impersonation headers are never overwritten by the identity helper', () => {
  const android = { 'User-Agent': 'Reddit/Version 2025.01.0/Build 1/Android 14', 'X-Reddit-Device-Id': 'abc' };
  assert.deepEqual(withAppUserAgent(android), android);
  const browser = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0.0.0 Safari/537.36' };
  assert.equal(withAppUserAgent(browser)['user-agent'], browser['user-agent']);
  assert.equal(withAppUserAgent(browser)['User-Agent'], undefined);
});
