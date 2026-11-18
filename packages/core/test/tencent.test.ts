import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { searchTencent } from '../src/tencent.js';
import { SearchError, type TransportOptions } from '../src/transport.js';
import type { AdapterInput } from '../src/types.js';

function input(maxResults = 5): AdapterInput {
  const config = defaultConfig();
  return {
    query: 'test', maxResults, config, key: JSON.stringify({ secretId: 'test-id', secretKey: 'test-secret' }),
    signal: new AbortController().signal,
    backend: { enabled: true, mode: 'key', endpoint: 'https://wsa.tencentcloudapi.com/',
      timeoutMs: 1000, rateLimitPerMinute: 0, dailyAttemptLimit: 0, options: { Mode: 2 } },
  };
}
function transport(handler: (url: string, init: RequestInit) => Response): TransportOptions {
  return {
    retry: { enabled: false, statuses: [], maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0, networkErrors: false, timeouts: false },
    signal: new AbortController().signal, attemptTimeoutMs: 1000, beforeAttempt() {}, onAttempt() {},
    fetch: (async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {})) as typeof fetch,
  };
}
const empty = (): Response => Response.json({ Response: { Pages: [], RequestId: 'test' } });

test('Tencent signs a fixed UTC request with an independently calculated TC3 vector', async context => {
  context.mock.method(Date, 'now', () => 1551113065000);
  await searchTencent(input(), transport((url, init) => {
    assert.equal(url, 'https://wsa.tencentcloudapi.com/');
    assert.equal(init.method, 'POST');
    assert.equal(init.body, '{"Query":"test","Cnt":10,"Mode":2}');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('host'), 'wsa.tencentcloudapi.com');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('x-tc-action'), 'SearchPro');
    assert.equal(headers.get('x-tc-version'), '2025-05-08');
    assert.equal(headers.get('x-tc-timestamp'), '1551113065');
    assert.equal(headers.get('x-tc-region'), null);
    // Independently derived using Python hashlib/hmac and Tencent's canonical-request specification.
    assert.equal(headers.get('authorization'), 'TC3-HMAC-SHA256 Credential=test-id/2019-02-25/wsa/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=4e1cea3458a5550e5dc5cbb5e89f95f298afda104e036ac62346bbcad73f0c01');
    assert.ok(!String(init.body).includes('test-secret'));
    return empty();
  }));
});

test('Tencent maps result counts to documented increments and forwards only known request fields', async () => {
  for (const [count, expected] of [[1, 10], [10, 10], [11, 20], [29, 30], [31, 40], [50, 50]] as const) {
    const i = input(count);
    i.backend.options.unknown = 'DO_NOT_FORWARD';
    await searchTencent(i, transport((_url, init) => {
      assert.deepEqual(JSON.parse(String(init.body)) as unknown, { Query: 'test', Cnt: expected, Mode: 2 });
      return empty();
    }));
  }
  const i = input(); delete i.backend.options.Mode;
  await searchTencent(i, transport((_url, init) => {
    assert.deepEqual(JSON.parse(String(init.body)) as unknown, { Query: 'test', Cnt: 10 });
    return empty();
  }));
});

test('Tencent parses Pages strings and maps passages, dynamic summaries, dates and safe URLs', async () => {
  const r = await searchTencent(input(1), transport(() => Response.json({ Response: { Pages: [
    JSON.stringify({ title: 'Title', url: 'https://example.org/article', passage: 'Static', content: 'Dynamic', date: '2026/11/17' }),
    JSON.stringify({ title: 'Second', url: 'https://example.org/second' }),
    JSON.stringify({ url: 'javascript:alert(1)' }),
    JSON.stringify({ url: 'https://user:password@example.org' }),
  ] } })));
  assert.deepEqual(r.sources, [{ title: 'Title', url: 'https://example.org/article', snippet: 'Static', summary: 'Dynamic', publishedAt: '2026/11/17' }]);
});

test('Tencent rejects malformed credentials, unsupported access and settings before network without leaking secrets', async () => {
  let calls = 0;
  const t = transport(() => { calls++; return empty(); });
  const cases: AdapterInput[] = [];
  for (const key of ['PRIVATE_SECRET', '{"secretId":"PRIVATE_ID","secretKey":', '{}', '{"secretId":"bad\\r\\nheader","secretKey":"PRIVATE_SECRET"}']) {
    cases.push({ ...input(), key });
  }
  const anonymous = input(); anonymous.backend.mode = 'anonymous'; cases.push(anonymous);
  const mode = input(); mode.backend.options.Mode = '2'; cases.push(mode);
  const count = input(51); cases.push(count);
  const endpoint = input(); endpoint.backend.endpoint = 'https://example.org/'; cases.push(endpoint);
  for (const i of cases) {
    await assert.rejects(searchTencent(i, t), (error: unknown) => {
      assert.ok(error instanceof SearchError); assert.equal(error.kind, 'configuration');
      assert.doesNotMatch(error.message, /PRIVATE|test-secret|test-id|bad.*header/);
      return true;
    });
  }
  assert.equal(calls, 0);
});

test('Tencent HTTP-200 errors and malformed Pages fail safely without upstream error messages', async () => {
  for (const [payload, kind] of [
    [{ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: 'PRIVATE_SECRET PRIVATE_ID' } } }, 'authentication'],
    [{ Response: { Error: { Code: 'RequestLimitExceeded', Message: 'PRIVATE_SECRET' } } }, 'rate-limit'],
    [{ Response: { Error: { Code: 'InternalError', Message: 'PRIVATE_SECRET' } } }, 'protocol'],
    [{ Response: { Pages: ['PRIVATE_SECRET'] } }, 'protocol'],
    [{ Response: { Pages: [{}] } }, 'protocol'],
    [{ Response: {} }, 'protocol'],
    [{ wrong: [] }, 'protocol'],
  ] as const) {
    await assert.rejects(searchTencent(input(), transport(() => Response.json(payload))), (error: unknown) => {
      assert.ok(error instanceof SearchError); assert.equal(error.kind, kind);
      assert.doesNotMatch(error.message, /PRIVATE|test-secret|test-id/); return true;
    });
  }
  await assert.rejects(searchTencent(input(), transport(() => new Response('PRIVATE_SECRET', { status: 403 }))), (error: unknown) => {
    assert.ok(error instanceof SearchError); assert.equal(error.kind, 'authentication');
    assert.doesNotMatch(error.message, /PRIVATE/); return true;
  });
});
