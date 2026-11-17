// Xiaohongshu reads, exercised against an injected page evaluator: the browser itself is the
// user's, so these tests assert the contract around it (script selection, answer mapping, errors).

import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchError } from '../src/transport.js';
import { catalog } from '../src/catalog.js';
import { connectFailure } from '../src/xhs/browser.js';
import { fetchXhsComments, fetchXhsNote, readXhsSearchNotes, resolveTarget, searchXhs } from '../src/xhs/index.js';

interface Call { script: string }

function fakeBrowser(answers: unknown[]) {
  const calls: Call[] = [];
  let closed = false;
  const browser = {
    async target() { return null; },
    async evaluate(script: string) {
      calls.push({ script });
      if (answers.length === 0) throw new Error('no more answers');
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    async close() { closed = true; },
    get isClosed() { return closed; },
  };
  return { browser, calls, closed: () => closed };
}

const ready = { ok: true, guest: false, signedIn: true };
const ctx = (browser: unknown) => ({ wsEndpoint: 'ws://127.0.0.1:3000/xhs', token: 'T', timeoutMs: 1000, signal: new AbortController().signal, browser: browser as never });

test('xiaohongshu is a self-hosted browser backend with no credential requirement', () => {
  const entry = catalog.find(item => item.id === 'xiaohongshu');
  assert.ok(entry, 'the backend must exist in the catalog');
  assert.deepEqual(entry!.modes.map(mode => mode.mode), ['browser']);
  assert.equal(entry!.modes[0]!.tier, 'self-hosted');
  assert.match(entry!.modes[0]!.limits.en, /browser you host/);
});

test('a search becomes citeable sources and drops the note token', async () => {
  const { browser, calls } = fakeBrowser([ready, { ok: true, hasMore: true, items: [
    { id: 'n1', title: '标题', author: '作者', likes: '12', url: 'https://www.xiaohongshu.com/explore/n1', xsecToken: 'SECRET' },
  ] }]);
  const sources = await searchXhs({ query: 'DeepSeek', maxResults: 5 }, ctx(browser));
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.url, 'https://www.xiaohongshu.com/explore/n1');
  assert.match(sources[0]!.summary!, /作者/);
  assert.doesNotMatch(JSON.stringify(sources), /SECRET/);
  assert.match(calls[1]!.script, /DeepSeek/);
});

test('every read checks the page first and closes only the connection', async () => {
  const { browser, calls, closed } = fakeBrowser([ready, { ok: true, items: [] }]);
  await readXhsSearchNotes({ query: 'q', limit: 3 }, ctx(browser));
  assert.match(calls[0]!.script, /webpackChunkxhs_pc_web/);
  assert.equal(closed(), true);
});

test('a signed-out page is an authentication failure, not an empty result', async () => {
  const { browser } = fakeBrowser([ready, { ok: false, code: 'CALL_FAILED', status: 406, message: 'not logged in' }]);
  await assert.rejects(searchXhs({ query: 'q', maxResults: 3 }, ctx(browser)), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.kind, 'authentication');
    assert.match(error.message, /sign in/i);
    return true;
  });
});

test('a page that never loaded the site reports a protocol problem with the fix', async () => {
  const { browser } = fakeBrowser([{ ok: false, code: 'NO_RUNTIME', message: 'no require' }]);
  await assert.rejects(searchXhs({ query: 'q', maxResults: 3 }, ctx(browser)), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.kind, 'protocol');
    assert.match(error.message, /Open xiaohongshu\.com/);
    return true;
  });
});

test('rate limits and private notes stay distinguishable', async () => {
  const limited = fakeBrowser([ready, { ok: false, code: 'CALL_FAILED', status: 429 }]);
  await assert.rejects(searchXhs({ query: 'q', maxResults: 3 }, ctx(limited.browser)), (error: unknown) => ((error as SearchError).kind === 'rate-limit'));
  const denied = fakeBrowser([ready, { ok: false, code: 'CALL_FAILED', status: 403, message: 'private' }]);
  await assert.rejects(searchXhs({ query: 'q', maxResults: 3 }, ctx(denied.browser)), (error: unknown) => ((error as SearchError).kind === 'authentication'));
});

test('a note read takes its token from the share link', async () => {
  const { browser, calls } = fakeBrowser([ready, { ok: true, note: { id: 'abc123', title: 't', desc: 'd', author: 'a', likes: '1', collects: '0', comments: '0', shares: '0', tags: [], images: 1, url: 'u' } }]);
  const note = await fetchXhsNote({ url: 'https://www.xiaohongshu.com/explore/abc123?xsec_token=TOKEN123&xsec_source=pc_feed' }, ctx(browser));
  assert.equal(note.id, 'abc123');
  assert.match(calls[1]!.script, /TOKEN123/, 'the token from the link reaches the page script');
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
  const { browser, calls } = fakeBrowser([ready, { ok: true, comments: [{ id: 'c1', author: 'a', content: 'hi', likes: '2', replies: '0' }], hasMore: false }]);
  const result = await fetchXhsComments({ id: 'abc123', token: 'T', limit: 500 }, ctx(browser));
  assert.equal(result.comments.length, 1);
  assert.match(calls[1]!.script, /limit|>=100/, 'the page script caps the page size');
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
