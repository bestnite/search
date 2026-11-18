// Xiaohongshu reads, exercised against an injected transaction session: the browser itself is the
// user's, so these tests assert the contract around it (one serialised transaction per read, script
// selection, answer mapping, state policy and errors).

import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchError } from '../src/transport.js';
import { catalog } from '../src/catalog.js';
import type { BrowserReader } from '../src/browser.js';
import { connectFailure } from '../src/browser.js';
import { DEFAULT_STATE_PATH, fetchXhsComments, fetchXhsNote, optionsOf, readXhsSearchNotes, resolveTarget, searchXhs } from '../src/xhs/index.js';

interface Call { script: string }

/**
 * A stand-in for the kept session. It records the transaction boundary, the scripts and whether the
 * transaction asked for invalidation, and still exposes close/persist so the test can prove a read
 * never reaches for them.
 */
function fakeSession(answers: unknown[]) {
  const calls: Call[] = [];
  let closed = 0;
  let persisted = 0;
  let invalidated = 0;
  let transactions = 0;
  let receivedSignal: AbortSignal | undefined;
  const session = {
    async read<T>(run: (reader: BrowserReader) => Promise<T>, signal?: AbortSignal): Promise<T> {
      transactions += 1;
      receivedSignal = signal;
      const reader: BrowserReader = {
        evaluate: async <V>(script: string): Promise<V> => {
          calls.push({ script });
          if (answers.length === 0) throw new Error('no more answers');
          const next = answers.shift();
          if (next instanceof Error) throw next;
          return next as V;
        },
        invalidate: () => {
          invalidated += 1;
        },
      };
      return run(reader);
    },
    async close() {
      closed += 1;
    },
    async persist() {
      persisted += 1;
    },
  };
  return {
    session,
    calls,
    closed: () => closed,
    persisted: () => persisted,
    invalidated: () => invalidated,
    transactions: () => transactions,
    signal: () => receivedSignal,
  };
}

const ready: unknown = { ok: true, guest: false, signedIn: true };
const ctx = (session: unknown, extra: Record<string, unknown> = {}) => ({
  wsEndpoint: 'ws://127.0.0.1:3000/xhs',
  token: 'T',
  timeoutMs: 1_000,
  signal: new AbortController().signal,
  browser: session as never,
  ...extra,
});

const summary = (id = 'n1', token = 'SECRET') => ({
  id,
  title: '标题',
  author: '作者',
  likes: '12',
  url: `https://www.xiaohongshu.com/explore/${id}`,
  xsecToken: token,
});

const note = (id = 'abc123') => ({
  id,
  title: 't',
  desc: 'd',
  author: 'a',
  likes: '1',
  collects: '0',
  comments: '0',
  shares: '0',
  tags: [],
  imageUrls: [],
  url: `https://www.xiaohongshu.com/explore/${id}`,
});

test('xiaohongshu is a self-hosted browser backend with no credential requirement', () => {
  const entry = catalog.find(item => item.id === 'xiaohongshu');
  assert.ok(entry, 'the backend must exist in the catalog');
  assert.deepEqual(entry!.modes.map(mode => mode.mode), ['browser']);
  assert.equal(entry!.modes[0]!.tier, 'self-hosted');
  assert.match(entry!.modes[0]!.limits.en, /browser you host/);
});

test('a search becomes citeable sources and drops the note token', async () => {
  const fake = fakeSession([ready, { ok: true, hasMore: true, items: [summary()] }]);
  const sources = await searchXhs({ query: 'DeepSeek', maxResults: 5 }, ctx(fake.session));
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.url, 'https://www.xiaohongshu.com/explore/n1');
  assert.match(sources[0]!.summary!, /作者/);
  assert.doesNotMatch(JSON.stringify(sources), /SECRET/);
  assert.match(fake.calls[1]!.script, /DeepSeek/);
});

test('a read is one transaction: health probe, action, and no close or persist of its own', async () => {
  const fake = fakeSession([ready, { ok: true, hasMore: false, items: [] }]);
  await readXhsSearchNotes({ query: 'q', limit: 3 }, ctx(fake.session));
  assert.equal(fake.transactions(), 1, 'one transaction per read');
  assert.match(fake.calls[0]!.script, /webpackChunkxhs_pc_web/, 'the health probe runs first');
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.closed(), 0, 'the session owns the connection; a read must not close it');
  assert.equal(fake.persisted(), 0, 'the keeper owns the state file; a read must not write it');
});

test('the caller signal reaches the session transaction', async () => {
  const fake = fakeSession([ready, { ok: true, items: [] }]);
  const controller = new AbortController();
  await searchXhs({ query: 'q', maxResults: 3 }, ctx(fake.session, { signal: controller.signal }));
  assert.equal(fake.signal(), controller.signal);
});

test('a signed-out page is an authentication failure, invalidates the page, and is not retried', async () => {
  const fake = fakeSession([ready, { ok: false, code: 'CALL_FAILED', status: 406, message: 'not logged in' }]);
  await assert.rejects(searchXhs({ query: 'q', maxResults: 3 }, ctx(fake.session)), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.kind, 'authentication');
    assert.match(error.message, /sign in/i);
    return true;
  });
  assert.equal(fake.invalidated(), 1, 'the stale page is dropped so the next read reloads the state file');
  assert.equal(fake.transactions(), 1, 'the failed search is not replayed automatically');
  assert.equal(fake.calls.length, 2, 'one health probe and one search: no second attempt');
  assert.equal(fake.closed(), 0);
  assert.equal(fake.persisted(), 0);
});

test('a guest identity fails before any business script and invalidates the page', async () => {
  const fake = fakeSession([{ ok: true, guest: true, signedIn: false }]);
  await assert.rejects(searchXhs({ query: 'q', maxResults: 3 }, ctx(fake.session)), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.kind, 'authentication');
    assert.match(error.message, /guest/i);
    return true;
  });
  assert.equal(fake.invalidated(), 1, 'the stale page is dropped for a reload');
  assert.equal(fake.calls.length, 1, 'only the identity probe ran; no business script was sent');
  assert.equal(fake.transactions(), 1);
  assert.equal(fake.closed(), 0);
  assert.equal(fake.persisted(), 0);
});

test('a login answer in the body also invalidates the page', async () => {
  const fake = fakeSession([ready, { ok: false, code: 'CALL_FAILED', message: '请先登录' }]);
  await assert.rejects(searchXhs({ query: 'q', maxResults: 3 }, ctx(fake.session)), /not signed in/);
  assert.equal(fake.invalidated(), 1);
});

test('a page that never loaded the site reports a protocol problem with the fix', async () => {
  const fake = fakeSession([{ ok: false, code: 'NO_RUNTIME', message: 'no require' }]);
  await assert.rejects(searchXhs({ query: 'q', maxResults: 3 }, ctx(fake.session)), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.kind, 'protocol');
    assert.match(error.message, /Open xiaohongshu\.com/);
    return true;
  });
  assert.equal(fake.invalidated(), 0, 'a missing runtime is not an expired sign-in');
  assert.equal(fake.calls.length, 1);
});

test('rate limits and private notes stay distinguishable, and a private note does not invalidate the session', async () => {
  const limited = fakeSession([ready, { ok: false, code: 'CALL_FAILED', status: 429 }]);
  await assert.rejects(searchXhs({ query: 'q', maxResults: 3 }, ctx(limited.session)), (error: unknown) => ((error as SearchError).kind === 'rate-limit'));
  assert.equal(limited.invalidated(), 0);

  const denied = fakeSession([ready, { ok: false, code: 'CALL_FAILED', status: 403, message: 'private' }]);
  await assert.rejects(searchXhs({ query: 'q', maxResults: 3 }, ctx(denied.session)), (error: unknown) => ((error as SearchError).kind === 'authentication'));
  assert.equal(denied.invalidated(), 0, 'a private subject is not a reason to drop the signed-in page');
});

test('a note read takes its token from the share link', async () => {
  const fake = fakeSession([ready, { ok: true, note: note() }]);
  const read = await fetchXhsNote({ url: 'https://www.xiaohongshu.com/explore/abc123?xsec_token=TOKEN123&xsec_source=pc_feed' }, ctx(fake.session));
  assert.equal(read.id, 'abc123');
  assert.match(fake.calls[1]!.script, /TOKEN123/, 'the token from the link reaches the page script');
});

test('a note read can reuse the token remembered from an earlier search', async () => {
  const fake = fakeSession([ready, { ok: true, items: [summary('remembered1', 'REMEMBER_ME')] }, ready, { ok: true, note: note('remembered1') }]);
  await readXhsSearchNotes({ query: 'q', limit: 1 }, ctx(fake.session));
  await fetchXhsNote({ id: 'remembered1' }, ctx(fake.session));
  assert.match(fake.calls[3]!.script, /REMEMBER_ME/);
  assert.equal(fake.transactions(), 2);
});

test('targets without a token are refused with a usable message', () => {
  assert.deepEqual(resolveTarget({ url: 'https://www.xiaohongshu.com/explore/abc123?xsec_token=T' }), { id: 'abc123', token: 'T' });
  assert.deepEqual(resolveTarget({ id: 'abc123', token: 'T' }), { id: 'abc123', token: 'T' });
  assert.throws(() => resolveTarget({ id: 'abc123' }), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.kind, 'configuration');
    assert.match(error.message, /xsec_token/);
    return true;
  });
  assert.throws(() => resolveTarget({ url: 'https://[unparseable' }), /not a Xiaohongshu note URL/);
  assert.throws(() => resolveTarget({ url: 'not a url' }), /xsec_token/, 'a bare string is treated as an id, so the token is what is missing');
});

test('comments are capped and passed through', async () => {
  const fake = fakeSession([ready, { ok: true, comments: [{ id: 'c1', author: 'a', content: 'hi', likes: '2', replies: '0' }], hasMore: false }]);
  const result = await fetchXhsComments({ id: 'abc123', token: 'T', limit: 500 }, ctx(fake.session));
  assert.equal(result.comments.length, 1);
  assert.match(fake.calls[1]!.script, /limit|>=100/, 'the page script caps the page size');
});

test('the xhs session policy is read-only: it loads the state file but never writes the keeper file', () => {
  const bare = { wsEndpoint: 'ws://127.0.0.1:3000/xhs', timeoutMs: 1_000, signal: new AbortController().signal };
  const options = optionsOf(bare);
  assert.equal(options.statePolicy, 'read-only');
  assert.equal(options.statePath, process.env.XHS_STATE_PATH ?? DEFAULT_STATE_PATH);
  assert.equal(optionsOf({ ...bare, statePath: '/tmp/xhs-state.json' }).statePath, '/tmp/xhs-state.json');
  assert.equal(optionsOf({ ...bare, maxConcurrentReads: 3 }).maxConcurrentReads, 3);
  assert.equal('maxConcurrentReads' in optionsOf(bare), false, 'the default is left to the browser session');
});

test('connection failures explain which side to fix', () => {
  const options = { wsEndpoint: 'ws://127.0.0.1:3000/xhs', siteUrl: 'https://www.xiaohongshu.com/explore', timeoutMs: 1000 };
  assert.match(connectFailure(new Error('connect ECONNREFUSED 127.0.0.1:3000'), options).message, /No Playwright server answered/);
  assert.equal(connectFailure(new Error('WebSocket error: 401 Unauthorized'), options).kind, 'authentication');
  assert.equal(connectFailure(new Error('Playwright version mismatch: server v1.51 client v1.52'), options).kind, 'protocol');
  assert.match(connectFailure(new Error('version mismatch'), options).message, /major\.minor/);
});

test('a missing endpoint is a configuration error before any browser work', async () => {
  await assert.rejects(searchXhs({ query: 'q', maxResults: 3 }, { wsEndpoint: '', timeoutMs: 1000, signal: new AbortController().signal }), (error: unknown) => {
    assert.equal((error as SearchError).kind, 'configuration');
    assert.match((error as SearchError).message, /Playwright endpoint/);
    return true;
  });
});
