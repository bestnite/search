// Opt-in live integration test. It is NOT part of `npm test` (the runner only matches
// `test/*.test.ts`). It runs only when the operator supplies a browser endpoint:
//
//   BROWSER_WS_ENDPOINT=ws://... BROWSER_TOKEN=... BROWSER_STATE_PATH=/path/state.json \
//     node --import tsx --test test/browser-live.integration.ts
//
// The test never reads the production container configuration, never prints the token, a cookie,
// a raw response or an xsecToken, and never retries a rate-limit/auth/challenge answer. The
// Xiaohongshu part warms up with the identity probe only, then submits batches of 1/2/3 searches
// on one cap-3 session (six submissions in total) and uses no pagination.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'patchright-core';
import { BrowserSession, closeBrowserSessions, type BrowserSessionOptions } from '../src/browser.js';
import { SearchError } from '../src/transport.js';
import { healthScript } from '../src/xhs/scripts.js';
import { searchXhs, unwrapAnswer, type XhsContext } from '../src/xhs/index.js';

const endpoint = (process.env.BROWSER_WS_ENDPOINT ?? '').trim();
const token = (process.env.BROWSER_TOKEN ?? '').trim();
const statePath = (process.env.BROWSER_STATE_PATH ?? '').trim();
const timeoutMs = Number(process.env.BROWSER_LIVE_TIMEOUT_MS ?? 45_000);
const query = (process.env.BROWSER_LIVE_QUERY ?? 'DeepSeek').trim();
const concurrency = 3;

const connectWithCount = (counts: { connects: number }): BrowserSessionOptions['connect'] =>
  async (options: BrowserSessionOptions): Promise<Browser> => {
    counts.connects += 1;
    return chromium.connect(options.wsEndpoint, {
      timeout: options.timeoutMs,
      ...(options.token ? { headers: { authorization: `Bearer ${options.token}` } } : {}),
    });
  };

const localOptions = (counts: { connects: number }): BrowserSessionOptions => ({
  wsEndpoint: endpoint,
  // about:blank is deliberately the only non-http site the browser session accepts; no network.
  siteUrl: 'about:blank',
  timeoutMs,
  idleTimeoutMs: 0,
  ...(token ? { token } : {}),
  connect: connectWithCount(counts),
});

const xhsOptions = (counts: { connects: number }): BrowserSessionOptions => ({
  wsEndpoint: endpoint,
  siteUrl: 'https://www.xiaohongshu.com/explore',
  timeoutMs,
  idleTimeoutMs: 0,
  statePath,
  statePolicy: 'read-only',
  maxConcurrentReads: concurrency,
  connect: connectWithCount(counts),
  ...(token ? { token } : {}),
});

const contextFor = (session: BrowserSession, signal: AbortSignal): XhsContext => ({
  wsEndpoint: endpoint,
  timeoutMs,
  statePath,
  maxConcurrentReads: concurrency,
  signal,
  browser: session,
});

const stopReason = (error: unknown): 'rate-limit' | 'authentication' | 'challenge' | 'cancelled' | 'other' => {
  if (error instanceof SearchError) {
    if (error.kind === 'rate-limit') return 'rate-limit';
    if (error.kind === 'authentication') return 'authentication';
    if (error.kind === 'cancelled') return 'cancelled';
    if (error.kind === 'timeout') return 'other';
    if (/challenge|captcha|verify/i.test(error.message)) return 'challenge';
    return 'other';
  }
  return 'other';
};

const logLine = (message: string): void => {
  // Only counts, durations and coarse statuses may be printed; never payloads or credentials.
  process.stdout.write(`[browser-live] ${message}\n`);
};

interface Health { guest?: boolean; signedIn?: boolean; ok?: boolean }

test('live browser: one shared page, one attach for concurrent local evaluators, cap 2', { skip: endpoint === '' ? 'set BROWSER_WS_ENDPOINT' : false }, async () => {
  const counts = { connects: 0 };
  const session = new BrowserSession(localOptions(counts));
  try {
    const concurrent = await Promise.all([1, 2, 3, 4].map(() => session.evaluate<number>('async () => 1 + 1')));
    assert.deepEqual(concurrent, [2, 2, 2, 2]);
    assert.equal(counts.connects, 1, 'concurrent local reads shared one attach');
    assert.equal(await session.evaluate<string>('async () => String(typeof window)'), 'object');

    // The same page is shared: a marker written by one read is visible to another. The configured
    // about:blank page is reused exactly, so the marker is not lost to a per-read navigation.
    await session.evaluate<number>('async () => { window.__dshLiveMarker = 41; return 1; }');
    assert.equal(await session.evaluate<number>('async () => (window.__dshLiveMarker ?? 0) + 1'), 42);

    // The admission limit is real: four evaluators, at most two in the page at once.
    const script = `async () => {
      const w = window;
      w.__dshActive = (w.__dshActive || 0) + 1;
      w.__dshMax = Math.max(w.__dshMax || 0, w.__dshActive);
      await new Promise(resolve => setTimeout(resolve, 120));
      w.__dshActive -= 1;
      return true;
    }`;
    await Promise.all([1, 2, 3, 4].map(() => session.evaluate<boolean>(script)));
    const peak = await session.evaluate<number>('async () => window.__dshMax || 0');
    assert.equal(peak, 2, `peak in-page concurrency was ${peak}, expected the local cap of 2`);
    logLine(`local shared-page/concurrency check ok (connects=${counts.connects}, peak=${peak})`);
  } finally {
    await session.close();
  }
});

test('live xhs: warm up identity, then 1/2/3 concurrent searches on one cap-3 session', { skip: !endpoint || !statePath ? 'set BROWSER_WS_ENDPOINT and BROWSER_STATE_PATH' : false }, async () => {
  const counts = { connects: 0 };
  const session = new BrowserSession(xhsOptions(counts));
  let attempted = 0;
  let stopped = false;
  const batches: Array<{ concurrency: number; durationMs: number; ok: number; sources: number; statuses: string[] }> = [];
  try {
    // Cold phase: open the page and check identity only. No search is sent during warm-up.
    const warmStarted = Date.now();
    let warmStatus: 'signed-in' | 'stopped' | 'failed' = 'failed';
    let warmKind = 'none';
    let coldInitMs: number | undefined;
    try {
      const health: Health = await session.read(async reader => unwrapAnswer<Health>(await reader.evaluate(healthScript())));
      coldInitMs = Date.now() - warmStarted;
      if (health.guest === true) {
        warmStatus = 'stopped';
        warmKind = 'guest';
      } else if (health.signedIn !== true) {
        warmStatus = 'stopped';
        warmKind = 'signedOut';
      } else {
        warmStatus = 'signed-in';
        logLine(`xhs warmup status=${warmStatus} coldInitMs=${coldInitMs} connects=${counts.connects}`);
      }
      if (warmStatus !== 'signed-in') {
        logLine(`xhs warmup stopped status=${warmStatus} kind=${warmKind} coldInitMs=${coldInitMs ?? 'n/a'}; business reads were not sent`);
      }
    } catch (error) {
      warmKind = stopReason(error);
      logLine(`xhs warmup stopped kind=${warmKind}; business reads were not sent`);
    }
    if (warmStatus !== 'signed-in') {
      if (warmStatus === 'failed' && warmKind === 'other') assert.fail('live warmup failed with an unexpected error kind');
      return;
    }

    // Hot phase: same session, same page, cap 3. Each batch gets its own abort controller; the
    // first non-ok answer aborts reads still queued in that batch (already-sent reads are not
    // retracted), and no later batch starts.
    for (const width of [1, 2, 3]) {
      if (stopped) break;
      const controller = new AbortController();
      const started = Date.now();
      const calls = Array.from({ length: width }, () => {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
        return searchXhs({ query, maxResults: 3 }, contextFor(session, signal))
          .then(
            sources => ({ status: 'ok', sources: sources.length }),
            error => {
              const status = stopReason(error);
              // A cancellation caused by this batch's own abort is expected; every other refusal
              // (including a per-call timeout that surfaces as cancelled) stops the batch and all
              // later batches. Queued reads here then see the abort without a page call.
              if (status !== 'cancelled' || !controller.signal.aborted) {
                stopped = true;
                controller.abort();
              }
              return { status, sources: 0 };
            },
          )
          .then(result => {
            attempted += 1;
            return result;
          });
      });
      const batch = await Promise.all(calls);
      const statuses = batch.map(item => item.status);
      const summary = {
        concurrency: width,
        durationMs: Date.now() - started,
        ok: batch.filter(item => item.status === 'ok').length,
        sources: batch.reduce((total, item) => total + item.sources, 0),
        statuses,
      };
      batches.push(summary);
      logLine(`xhs concurrency=${width} durationMs=${summary.durationMs} ok=${summary.ok}/${width} sources=${summary.sources} status=${statuses.join(',')}`);
      if (stopped) break;
    }

    assert.ok(attempted <= 6, `attempted ${attempted} searches, the live cap is 6`);
    assert.ok(batches.length > 0, 'at least one live batch ran');
    const unexpected = batches.flatMap(batch => batch.statuses).filter(status => status === 'other');
    assert.deepEqual(unexpected, [], 'unexpected live failure; see the logged status counts');
    assert.equal(counts.connects, 1, 'the whole run shared one attach');
    logLine(`xhs live summary batches=${batches.length} attempts=${attempted} stopped=${stopped}`);
  } finally {
    await session.close();
    await closeBrowserSessions();
  }
});
