// Browser session lifecycle and bounded concurrency, exercised against a fake browser that behaves
// like Playwright where it matters: closing a page, context or connection rejects every call still
// in flight. Gates are deferred promises, so no test depends on a sleep to order work.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession, closeBrowserSessions, sessionFor, type BrowserSessionOptions } from '../src/browser.js';
import { SearchError } from '../src/transport.js';
import { fetchXhsComments, fetchXhsNote, optionsOf, searchXhs, type XhsContext } from '../src/xhs/index.js';

const closedError = (): Error => new Error('Target page, context or browser has been closed');

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

// The idle tests wait for a release the session schedules on an unref'd timer. Not holding the
// process open is right for a library, but it lets the test process exit while one of those tests is
// still waiting, which the runner reports as `cancelledByParent` / "the event loop has already
// resolved" (Node 22 does this; Node 26 keeps the loop alive on its own). Pin the loop for the file.
const loopPin = setInterval(() => {}, 60_000);
after(() => clearInterval(loopPin));

interface PageCall {
  readonly source: string;
  readonly page: FakePage;
  run(): Promise<unknown>;
  settle(value: unknown): void;
  fail(error: unknown): void;
}

class FakeWorld {
  connects = 0;
  connectFailures = 0;
  initialPageUrl = 'about:blank';
  activeEvaluations = 0;
  maxActiveEvaluations = 0;
  readonly contexts: FakeContext[] = [];
  readonly pages: FakePage[] = [];
  readonly browsers: FakeBrowser[] = [];
  readonly browserClosed = new Deferred<void>();
  onBrowserClose: (() => void) | undefined;
  /** Held before a connection is created, so a test can resolve it after close() won the race. */
  connectGate: Deferred<void> | undefined;
  onConnect: (() => void) | undefined;
  /** Held inside newContext after its open check, so it can resolve late too. */
  newContextGate: Deferred<void> | undefined;
  onNewContext: (() => void) | undefined;
  onPageCall: (call: PageCall) => void = call => {
    void call.run().then(call.settle, call.fail);
  };

  enterEvaluation(): void {
    this.activeEvaluations += 1;
    this.maxActiveEvaluations = Math.max(this.maxActiveEvaluations, this.activeEvaluations);
  }

  leaveEvaluation(): void {
    this.activeEvaluations = Math.max(0, this.activeEvaluations - 1);
  }

  async connect(_options: BrowserSessionOptions): Promise<FakeBrowser> {
    this.onConnect?.();
    if (this.connectGate) await this.connectGate.promise;
    this.connects += 1;
    if (this.connectFailures > 0) {
      this.connectFailures -= 1;
      throw new Error('connect ECONNREFUSED 127.0.0.1:3000');
    }
    const browser = new FakeBrowser(this);
    this.browsers.push(browser);
    return browser;
  }
}

class FakeBrowser {
  disconnected = false;
  closeCalls = 0;
  closeGate: Deferred<void> | undefined;
  readonly contextsList: FakeContext[] = [];
  constructor(private readonly world: FakeWorld) {}

  isConnected(): boolean {
    return !this.disconnected;
  }

  contexts(): FakeContext[] {
    return this.contextsList.filter(context => !context.closed);
  }

  async newContext(options: { storageState?: string } = {}): Promise<FakeContext> {
    if (this.disconnected) throw closedError();
    this.world.onNewContext?.();
    // No second disconnected check on purpose: a gated test resolves this after close() has
    // already dropped the connection, which is exactly the late resource the session must close.
    if (this.world.newContextGate) await this.world.newContextGate.promise;
    const initialState = options.storageState ? readFileSync(options.storageState, 'utf8') : undefined;
    const context = new FakeContext(this, this.world, initialState);
    this.contextsList.push(context);
    this.world.contexts.push(context);
    return context;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.world.onBrowserClose?.();
    if (this.closeGate) await this.closeGate.promise;
    if (this.disconnected) return;
    this.disconnected = true;
    for (const context of this.contextsList) await context.close();
    this.world.browserClosed.resolve();
  }
}

class FakeContext {
  closed = false;
  storageAttempts = 0;
  failStorageState = 0;
  readonly pagesList: FakePage[] = [];
  readonly storageStates: string[] = [];
  constructor(
    readonly browser: FakeBrowser,
    private readonly world: FakeWorld,
    readonly initialState?: string,
  ) {}

  pages(): FakePage[] {
    return this.pagesList.filter(page => !page.closed);
  }

  async newPage(): Promise<FakePage> {
    if (this.closed || this.browser.disconnected) throw closedError();
    const page = new FakePage(this, this.world);
    this.pagesList.push(page);
    this.world.pages.push(page);
    return page;
  }

  async storageState(options: { path?: string } = {}): Promise<{ cookies: never[]; origins: never[] }> {
    if (this.closed) throw closedError();
    this.storageAttempts += 1;
    if (this.failStorageState > 0) {
      this.failStorageState -= 1;
      throw new Error('no space left');
    }
    this.storageStates.push(options.path ?? '');
    if (options.path) writeFileSync(options.path, this.initialState ?? '{}');
    return { cookies: [], origins: [] };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const page of this.pagesList) await page.close();
  }
}

class FakePage {
  closed = false;
  gotoCalls = 0;
  urlValue: string;
  readonly calls: PageCall[] = [];
  private readonly pending = new Set<PageCall>();
  constructor(
    private readonly context: FakeContext,
    private readonly world: FakeWorld,
  ) {
    this.urlValue = world.initialPageUrl;
  }

  isClosed(): boolean {
    return this.closed;
  }

  url(): string {
    return this.urlValue;
  }

  async goto(url: string): Promise<null> {
    if (this.closed) throw closedError();
    this.gotoCalls += 1;
    this.urlValue = url;
    return null;
  }

  evaluate(fn: () => unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(closedError());
    this.world.enterEvaluation();
    return new Promise((resolve, reject) => {
      const call: PageCall = {
        source: String(fn),
        page: this,
        run: () => Promise.resolve(fn()),
        settle: value => {
          if (!this.pending.delete(call)) return;
          this.world.leaveEvaluation();
          resolve(value);
        },
        fail: error => {
          if (!this.pending.delete(call)) return;
          this.world.leaveEvaluation();
          reject(error);
        },
      };
      this.pending.add(call);
      this.calls.push(call);
      setImmediate(() => {
        if (this.pending.has(call)) this.world.onPageCall(call);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const call of [...this.pending]) call.fail(closedError());
    this.pending.clear();
  }
}

// --- helpers ---------------------------------------------------------------------------------

const options = (world: FakeWorld, extra: Partial<BrowserSessionOptions> = {}): BrowserSessionOptions => ({
  wsEndpoint: 'ws://127.0.0.1:3000/xhs',
  siteUrl: 'https://www.xiaohongshu.com/explore',
  timeoutMs: 1_000,
  // Most tests do not care about idle release; the ones that do override it.
  idleTimeoutMs: 0,
  connect: world.connect.bind(world) as unknown as BrowserSessionOptions['connect'],
  ...extra,
});

const sessionOf = (world: FakeWorld, extra: Partial<BrowserSessionOptions> = {}): BrowserSession =>
  new BrowserSession(options(world, extra));

const xhsContext = (session: BrowserSession, extra: Partial<XhsContext> = {}): XhsContext => ({
  wsEndpoint: 'ws://127.0.0.1:3000/xhs',
  timeoutMs: 1_000,
  signal: new AbortController().signal,
  browser: session,
  ...extra,
});

const readValue = (session: BrowserSession, value: string): Promise<string> =>
  session.read(reader => reader.evaluate<string>(`async () => ${JSON.stringify(value)}`));

const health = (): unknown => ({ ok: true, guest: false, signedIn: true });

const summary = (id = 'n1', title = 'title') => ({ id, title, author: 'author', likes: '1', url: `https://www.xiaohongshu.com/explore/${id}`, xsecToken: 'TOKEN' });
const note = (id = 'n1') => ({ id, title: 't', desc: 'd', author: 'a', likes: '1', collects: '0', comments: '0', shares: '0', tags: [], imageUrls: [], url: `https://www.xiaohongshu.com/explore/${id}` });

// The shared prelude mentions the identity and feed routes in every script, so classify by the
// client call in the script body, not by any route string.
const isHealth = (source: string): boolean => source.includes("client.get('/api/sns/web/v2/user/me')");
const isSearch = (source: string): boolean => source.includes("client.post('/api/sns/web/v2/search/notes'");
const isComments = (source: string): boolean => source.includes("client.get('/api/sns/web/v2/comment/page'");
const isNote = (source: string): boolean => source.includes("client.post('/api/sns/web/v1/feed'");

const xhsAnswer = (call: PageCall, overrides: { search?: unknown; note?: unknown; comments?: unknown; health?: unknown } = {}): unknown => {
  const source = call.source;
  if (isHealth(source)) return overrides.health ?? health();
  if (isSearch(source)) return overrides.search ?? { ok: true, hasMore: false, items: [summary()] };
  if (isComments(source)) return overrides.comments ?? { ok: true, comments: [{ id: 'c1', author: 'a', content: 'hi', likes: '0', replies: '0' }], hasMore: false };
  if (isNote(source)) return overrides.note ?? { ok: true, note: note() };
  throw new Error(`unexpected page script: ${source.slice(0, 120)}`);
};

// --- bounded concurrency ---------------------------------------------------------------------

test('four concurrent searches share one connection/context/page and stay within the cap', async () => {
  const world = new FakeWorld();
  world.onPageCall = call => call.settle(xhsAnswer(call));
  const session = sessionOf(world);
  const ctx = xhsContext(session);

  const results = await Promise.all([1, 2, 3, 4].map(index => searchXhs({ query: `q${index}`, maxResults: 2 }, ctx)));

  assert.deepEqual(results.map(result => result.length), [1, 1, 1, 1]);
  assert.equal(world.connects, 1, 'one connection');
  assert.equal(world.contexts.length, 1, 'one context');
  assert.equal(world.pages.length, 1, 'one page');
  assert.ok(world.maxActiveEvaluations > 1, `expected concurrent page calls, saw ${world.maxActiveEvaluations}`);
  assert.ok(world.maxActiveEvaluations <= 2, `default cap 2 was exceeded: ${world.maxActiveEvaluations}`);
  assert.equal(world.activeEvaluations, 0);
  assert.equal(world.contexts[0]!.closed, false, 'a read never closes the context');
  assert.equal(world.pages[0]!.closed, false, 'a read never closes the page');
  assert.equal(world.browsers[0]!.disconnected, false, 'a read never closes the connection');
  assert.deepEqual(world.contexts[0]!.storageStates, [], 'a read never writes the keeper state file');

  await session.close();
  assert.equal(world.browsers[0]!.disconnected, true, 'an explicit close does release the connection');
});

test('two stages of different transactions may interleave while results stay attributed', async () => {
  const world = new FakeWorld();
  const businessGate = new Deferred<void>();
  let heldBusiness = 0;
  const bothBusiness = new Deferred<void>();
  const sequence: string[] = [];
  world.onPageCall = call => {
    if (isHealth(call.source)) return call.settle(health());
    const label = isSearch(call.source) ? 'search' : isNote(call.source) ? 'note' : isComments(call.source) ? 'comments' : 'unknown';
    sequence.push(label);
    if (label === 'search' || label === 'note') {
      heldBusiness += 1;
      if (heldBusiness === 2) bothBusiness.resolve();
      void businessGate.promise.then(() => call.settle(xhsAnswer(call, {
        search: { ok: true, hasMore: false, items: [summary('alpha-result', 'alpha-title')] },
        note: { ok: true, note: note('beta-result') },
      })));
      return;
    }
    call.settle(xhsAnswer(call, { comments: { ok: true, comments: [{ id: 'gamma-result', author: 'a', content: 'gamma', likes: '0', replies: '0' }], hasMore: false } }));
  };
  const session = sessionOf(world);
  const ctx = xhsContext(session);

  const search = searchXhs({ query: 'alpha', maxResults: 1 }, ctx);
  const noteRead = fetchXhsNote({ id: 'beta', token: 'T' }, ctx);
  const commentRead = fetchXhsComments({ id: 'gamma', token: 'T' }, ctx);

  await bothBusiness.promise;
  await flush();
  assert.equal(world.maxActiveEvaluations, 2, 'two transactions were in flight at the same time');
  assert.equal(heldBusiness, 2, 'search and note business stages overlapped');
  businessGate.resolve();

  const [sources, readNote, comments] = await Promise.all([search, noteRead, commentRead]);
  assert.equal(sources[0]!.title, 'alpha-title', 'the search result belongs to the search');
  assert.equal(readNote.id, 'beta-result', 'the note result belongs to the note read');
  assert.equal(comments.comments[0]!.id, 'gamma-result', 'the comment result belongs to the comment read');
  assert.ok(world.maxActiveEvaluations <= 2, `cap exceeded: ${world.maxActiveEvaluations}`);
  assert.ok(sequence.filter(label => label === 'comments').length === 1);
  await session.close();
});

test('an explicit maxConcurrentReads raises the local cap', async () => {
  const world = new FakeWorld();
  const gate = new Deferred<void>();
  const three = new Deferred<void>();
  let held = 0;
  world.onPageCall = call => {
    held += 1;
    if (held === 3) three.resolve();
    void gate.promise.then(call.run).then(call.settle, call.fail);
  };
  const session = sessionOf(world, { maxConcurrentReads: 3 });
  const reads = [1, 2, 3, 4, 5].map(index => readValue(session, `value${index}`));
  await three.promise;
  await flush();
  assert.equal(world.activeEvaluations, 3, 'three reads were admitted at once');
  assert.ok(world.maxActiveEvaluations > 2 && world.maxActiveEvaluations <= 3);
  gate.resolve();
  assert.equal((await Promise.all(reads)).length, 5);
  assert.ok(world.maxActiveEvaluations <= 3, `cap 3 exceeded: ${world.maxActiveEvaluations}`);
  await session.close();
});

test('initialisation is single-flight for concurrent reads', async () => {
  const world = new FakeWorld();
  const gate = new Deferred<void>();
  const entered = new Deferred<void>();
  world.connectGate = gate;
  world.onConnect = () => entered.resolve();
  world.onPageCall = call => call.settle(xhsAnswer(call));
  const session = sessionOf(world);
  const ctx = xhsContext(session);

  const reads = [1, 2, 3, 4].map(index => searchXhs({ query: `q${index}`, maxResults: 1 }, ctx));
  await entered.promise;
  assert.equal(world.connects, 0, 'the attach has not returned yet');
  gate.resolve();
  const results = await Promise.all(reads);
  assert.equal(results.length, 4);
  assert.equal(world.connects, 1, 'one attach for four concurrent reads');
  assert.equal(world.contexts.length, 1, 'one context');
  assert.equal(world.pages.length, 1, 'one page');
  await session.close();
});

test('a queued abort never exceeds capacity or starts its script', async () => {
  const world = new FakeWorld();
  const gate = new Deferred<void>();
  const entered = new Deferred<void>();
  let held = 0;
  world.onPageCall = call => {
    if (call.source.includes('"A"') || call.source.includes('"B"')) {
      held += 1;
      if (held === 2) entered.resolve();
      void gate.promise.then(call.run).then(call.settle, call.fail);
      return;
    }
    void call.run().then(call.settle, call.fail);
  };
  const session = sessionOf(world); // default cap 2
  const a = readValue(session, 'A');
  const b = readValue(session, 'B');
  await entered.promise;

  const controller = new AbortController();
  const d = session.read(reader => reader.evaluate<string>('async () => "D"'), controller.signal);
  const c = readValue(session, 'C');
  controller.abort();
  await assert.rejects(d, (error: unknown) => (error as SearchError).kind === 'cancelled');
  await flush();
  assert.equal(world.maxActiveEvaluations, 2, 'the two admitted reads stayed at the cap');

  gate.resolve();
  assert.deepEqual(await Promise.all([a, b, c]), ['A', 'B', 'C']);
  assert.equal(world.pages[0]!.calls.some(call => call.source.includes('"D"')), false, 'the cancelled read never reached the page');
  assert.ok(world.maxActiveEvaluations <= 2);
  await session.close();
});

test('with cap 1, a queued abort does not let the next read overtake the running one', async () => {
  const world = new FakeWorld();
  const gate = new Deferred<void>();
  const entered = new Deferred<void>();
  world.onPageCall = call => {
    if (call.source.includes('"A"')) {
      entered.resolve();
      void gate.promise.then(call.run).then(call.settle, call.fail);
      return;
    }
    void call.run().then(call.settle, call.fail);
  };
  const session = sessionOf(world, { maxConcurrentReads: 1 });
  const running = readValue(session, 'A');
  await entered.promise;
  const controller = new AbortController();
  const cancelledRead = session.read(reader => reader.evaluate<string>('async () => "B"'), controller.signal);
  const next = readValue(session, 'C');
  controller.abort();
  await assert.rejects(cancelledRead, (error: unknown) => (error as SearchError).kind === 'cancelled');
  await flush();
  assert.equal(world.pages[0]!.calls.length, 1, 'B did not run and C did not start while A held the only slot');
  gate.resolve();
  assert.equal(await running, 'A');
  assert.equal(await next, 'C');
  assert.equal(world.pages[0]!.calls.length, 2);
  await session.close();
});

// --- concurrency edges -----------------------------------------------------------------------

test('an abort during a page call is reported only after that call finishes', async () => {
  const world = new FakeWorld();
  const gate = new Deferred<void>();
  const entered = new Deferred<void>();
  world.onPageCall = call => {
    if (call.source.includes('"slow"')) {
      entered.resolve();
      void gate.promise.then(call.run).then(call.settle, call.fail);
      return;
    }
    void call.run().then(call.settle, call.fail);
  };
  const session = sessionOf(world, { maxConcurrentReads: 1 });
  const controller = new AbortController();
  const first = session.read(reader => reader.evaluate<string>('async () => "slow"'), controller.signal);
  await entered.promise;
  controller.abort();
  const next = readValue(session, 'next');
  await flush();
  assert.equal(world.pages[0]!.calls.length, 1, 'the next read must not start while the page call is in flight');
  gate.resolve();
  await assert.rejects(first, (error: unknown) => (error as SearchError).kind === 'cancelled');
  assert.equal(await next, 'next');
  await session.close();
});

test('a shared initialisation failure rejects all waiters and the next attempt recovers', async () => {
  const world = new FakeWorld();
  world.connectFailures = 1;
  const session = sessionOf(world);
  const outcomes = await Promise.all([
    readValue(session, 'one').then(() => undefined, (error: unknown) => error),
    readValue(session, 'two').then(() => undefined, (error: unknown) => error),
  ]);
  for (const error of outcomes) {
    assert.ok(error instanceof SearchError);
    assert.equal(error.kind, 'network');
  }
  assert.equal(world.connects, 1, 'both waiters shared one failed attach');
  assert.equal(await readValue(session, 'three'), 'three');
  assert.equal(world.connects, 2, 'the cleared opening promise allowed a retry');
  await session.close();
});

test('a failed initialisation and a failed read do not poison the queue', async () => {
  const world = new FakeWorld();
  world.connectFailures = 1;
  const session = sessionOf(world);
  await assert.rejects(readValue(session, 'first'), (error: unknown) => (error as SearchError).kind === 'network');
  assert.equal(await readValue(session, 'second'), 'second');
  await assert.rejects(
    session.read(async reader => {
      await reader.evaluate('async () => "page"');
      throw new Error('the caller gave up after the read');
    }),
    /gave up/,
  );
  await assert.rejects(
    session.read(reader => reader.evaluate('async () => { throw new Error("page broke"); }')),
    (error: unknown) => (error as SearchError).kind === 'protocol',
  );
  assert.equal(await readValue(session, 'third'), 'third');
  assert.equal(world.connects, 2, 'one failed attach, one successful attach; failures did not reconnect');
  await session.close();
});

test('a closed page is rebuilt inside the same context; a dead connection is rebuilt entirely', async () => {
  const world = new FakeWorld();
  world.onPageCall = call => call.settle(xhsAnswer(call));
  const session = sessionOf(world);
  const ctx = xhsContext(session);
  await searchXhs({ query: 'one', maxResults: 1 }, ctx);

  await world.pages[0]!.close();
  await searchXhs({ query: 'two', maxResults: 1 }, ctx);
  assert.equal(world.connects, 1, 'closing a tab does not cost a new connection');
  assert.equal(world.contexts.length, 1, 'closing a tab does not cost a new context');
  assert.equal(world.pages.length, 2, 'only the page is rebuilt');

  const firstBrowser = world.browsers[0]!;
  const firstPage = world.pages[0]!;
  await firstBrowser.close();
  await searchXhs({ query: 'three', maxResults: 1 }, ctx);
  assert.equal(world.connects, 2, 'a dead connection is replaced');
  assert.equal(world.contexts.length, 2);

  // A late event from the abandoned connection must not touch the replacement.
  await firstBrowser.close();
  await firstPage.close();
  await searchXhs({ query: 'four', maxResults: 1 }, ctx);
  assert.equal(world.connects, 2, 'stale events caused no reconnect');
  assert.equal(world.pages.filter(page => !page.closed).length, 1);
  await session.close();
});

test('a page is reused only on the configured host, its subdomains or its www apex', async () => {
  const cases = [
    { url: 'https://www.xiaohongshu.com/explore', onSite: true },
    { url: 'https://sub.www.xiaohongshu.com/explore', onSite: true },
    { url: 'https://xiaohongshu.com/explore', onSite: true, reason: 'explicit www-stripped apex' },
    { url: 'https://m.xiaohongshu.com/explore', onSite: false, reason: 'sibling subdomain is not the configured host' },
    { url: 'https://www.xiaohongshu.com.evil.test/explore', onSite: false },
    { url: 'https://notxiaohongshu.com/explore', onSite: false },
    { url: 'https://com/explore', onSite: false, reason: 'public suffix ancestor' },
    { siteUrl: 'https://www.foo.co.uk/explore', url: 'https://co.uk/explore', onSite: false, reason: 'public suffix ancestor of a multi-label host' },
    { siteUrl: 'https://www.foo.co.uk/explore', url: 'https://foo.co.uk/explore', onSite: true, reason: 'www-stripped apex' },
    { siteUrl: 'https://www.foo.co.uk/explore', url: 'https://www.foo.co.uk.evil.test/explore', onSite: false },
    { siteUrl: 'https://foo.co.uk/explore', url: 'https://sub.foo.co.uk/explore', onSite: true },
  ];
  for (const item of cases) {
    const world = new FakeWorld();
    world.initialPageUrl = item.url;
    const session = sessionOf(world, item.siteUrl ? { siteUrl: item.siteUrl } : {});
    assert.equal(await readValue(session, 'x'), 'x');
    assert.equal(world.pages[0]!.gotoCalls, item.onSite ? 0 : 1, `${item.url} (${item.reason ?? 'same host'})`);
    await session.close();
  }
});

test('an exactly configured about:blank page is reused; no other about: URL is', async () => {
  const reused = new FakeWorld();
  reused.initialPageUrl = 'about:blank';
  const local = sessionOf(reused, { siteUrl: 'about:blank' });
  assert.equal(await readValue(local, 'local'), 'local');
  assert.equal(reused.pages[0]!.gotoCalls, 0, 'the exact local page was reused');
  await local.close();

  const navigated = new FakeWorld();
  navigated.initialPageUrl = 'about:blank#other';
  const fresh = sessionOf(navigated, { siteUrl: 'about:blank' });
  assert.equal(await readValue(fresh, 'local'), 'local');
  assert.equal(navigated.pages[0]!.gotoCalls, 1, 'a different about: URL is not the configured site');
  await fresh.close();
});

test('the legacy evaluate and target entry points use the same kept page and limiter', async () => {
  const world = new FakeWorld();
  const session = sessionOf(world);
  const page = await session.target();
  assert.equal(page, world.pages[0]);
  assert.equal(await session.evaluate<string>('async () => "legacy"'), 'legacy');
  assert.equal(await session.evaluate<string>('async () => "again"'), 'again');
  assert.equal(world.connects, 1);
  assert.equal(world.pages.length, 1);
  await session.close();
});

// --- invalidation / rate limits --------------------------------------------------------------

test('an auth failure invalidates its generation and the next read loads the new state file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xhs-session-'));
  const statePath = join(dir, 'state.json');
  writeFileSync(statePath, 'v1');
  try {
    const world = new FakeWorld();
    let failSearch = true;
    world.onPageCall = call => {
      if (isSearch(call.source) && failSearch) {
        call.settle({ ok: false, code: 'CALL_FAILED', status: 401, message: 'login required' });
        return;
      }
      call.settle(xhsAnswer(call));
    };
    const sessionOptions = optionsOf({
      wsEndpoint: 'ws://127.0.0.1:3000/xhs',
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      statePath,
    });
    const session = new BrowserSession({
      ...sessionOptions,
      idleTimeoutMs: 0,
      connect: world.connect.bind(world) as unknown as BrowserSessionOptions['connect'],
    });
    const ctx = xhsContext(session);

    await assert.rejects(searchXhs({ query: 'one', maxResults: 1 }, ctx), (error: unknown) => (error as SearchError).kind === 'authentication');
    await flush();
    assert.equal(world.contexts[0]!.initialState, 'v1');
    assert.equal(world.contexts[0]!.closed, true, 'the stale context was dropped');
    assert.equal(world.pages[0]!.calls.filter(call => isSearch(call.source)).length, 1, 'the failed search was not replayed');

    failSearch = false;
    writeFileSync(statePath, 'v2');
    const sources = await searchXhs({ query: 'two', maxResults: 1 }, ctx);
    assert.equal(sources.length, 1);
    assert.equal(world.connects, 2);
    assert.equal(world.contexts.length, 2);
    assert.equal(world.contexts[1]!.initialState, 'v2', 'the next read started from the current state file');
    await session.close();
    assert.deepEqual(world.contexts.flatMap(context => context.storageStates), [], 'the xhs read-only policy never wrote the state file');
    assert.equal(readFileSync(statePath, 'utf8'), 'v2', 'the keeper file is untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale generation stops new reads, drains its in-flight reads, then recycles once', async () => {
  const world = new FakeWorld();
  const betaEntered = new Deferred<void>();
  const betaGate = new Deferred<void>();
  world.onPageCall = call => {
    if (isHealth(call.source)) return call.settle(health());
    if (isSearch(call.source) && call.source.includes('"alpha"')) {
      return call.settle({ ok: false, code: 'CALL_FAILED', status: 401, message: 'login required' });
    }
    if (isNote(call.source)) {
      betaEntered.resolve();
      void betaGate.promise.then(() => call.settle({ ok: true, note: note('beta-result') }));
      return;
    }
    call.settle(xhsAnswer(call, { search: { ok: true, hasMore: false, items: [summary('gamma-result', 'gamma-title')] } }));
  };
  const session = sessionOf(world);
  const ctx = xhsContext(session);

  const alpha = searchXhs({ query: 'alpha', maxResults: 1 }, ctx).then(
    () => undefined,
    (error: unknown) => error,
  );
  const beta = fetchXhsNote({ id: 'beta', token: 'T' }, ctx);
  await betaEntered.promise;
  const alphaError = await alpha;
  assert.ok(alphaError instanceof SearchError);
  assert.equal(alphaError.kind, 'authentication');

  const gamma = searchXhs({ query: 'gamma', maxResults: 1 }, ctx);
  await flush();
  assert.equal(world.contexts[0]!.closed, false, 'the in-flight old-generation read kept its context alive');
  assert.equal(world.pages[0]!.calls.some(call => isSearch(call.source) && call.source.includes('"gamma"')), false, 'the new read did not join the stale generation');
  assert.equal(world.connects, 1, 'no replacement connection before the old generation drained');

  betaGate.resolve();
  const [readNote, sources] = await Promise.all([beta, gamma]);
  assert.equal(readNote.id, 'beta-result');
  assert.equal(sources[0]!.title, 'gamma-title');
  assert.equal(world.contexts[0]!.closed, true, 'the old generation was disposed after its last in-flight read');
  assert.equal(world.connects, 2, 'one replacement connection');
  assert.equal(world.contexts.length, 2);
  assert.equal(world.pages[0]!.calls.filter(call => isSearch(call.source) && call.source.includes('"alpha"')).length, 1, 'the failed search was not replayed');
  await session.close();
});

test('a rate-limit answer drops this session to one concurrent read, permanently and without replay', async () => {
  const world = new FakeWorld();
  let limited = true;
  let limitedCalls = 0;
  world.onPageCall = call => {
    if (isSearch(call.source) && call.source.includes('"limited"')) {
      limitedCalls += 1;
      if (limited) return call.settle({ ok: false, code: 'CALL_FAILED', status: 429 });
    }
    call.settle(xhsAnswer(call));
  };
  const session = sessionOf(world, { maxConcurrentReads: 4 });
  const ctx = xhsContext(session);

  await assert.rejects(searchXhs({ query: 'limited', maxResults: 1 }, ctx), (error: unknown) => (error as SearchError).kind === 'rate-limit');
  assert.equal(limitedCalls, 1, 'the rate-limited search was not replayed');

  world.maxActiveEvaluations = 0;
  const after = await Promise.all([1, 2, 3, 4].map(index => searchXhs({ query: `after${index}`, maxResults: 1 }, ctx)));
  assert.equal(after.length, 4);
  assert.equal(world.maxActiveEvaluations, 1, 'admission was lowered to one');

  // A page rebuild must not restore the configured concurrency.
  await world.pages[0]!.close();
  world.maxActiveEvaluations = 0;
  await Promise.all([1, 2].map(index => searchXhs({ query: `rebuilt${index}`, maxResults: 1 }, ctx)));
  assert.equal(world.maxActiveEvaluations, 1, 'the lowered limit survives a page rebuild');
  await session.close();
});

// --- state and persistence -------------------------------------------------------------------

test('the default policy may persist, and savedAt moves only after a save actually succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xhs-session-'));
  const statePath = join(dir, 'state.json');
  try {
    const world = new FakeWorld();
    const session = new BrowserSession(options(world, { statePath }));
    await readValue(session, 'one');
    const context = world.contexts[0]!;
    context.failStorageState = 1;
    await session.persist();
    assert.equal(context.storageAttempts, 1, 'the first save was attempted');
    assert.deepEqual(context.storageStates, [], 'the failed save is not recorded as success');
    await session.persist();
    assert.equal(context.storageAttempts, 2, 'the failed save did not move savedAt, so the next call retries');
    assert.deepEqual(context.storageStates, [statePath]);
    await session.persist();
    assert.equal(context.storageAttempts, 2, 'a successful save throttles the next one');
    await session.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persist is exclusive maintenance behind in-flight reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xhs-session-'));
  const statePath = join(dir, 'state.json');
  try {
    const world = new FakeWorld();
    const gate = new Deferred<void>();
    const entered = new Deferred<void>();
    world.onPageCall = call => {
      entered.resolve();
      void gate.promise.then(call.run).then(call.settle, call.fail);
    };
    const session = new BrowserSession(options(world, { statePath }));
    const read = readValue(session, 'held');
    await entered.promise;
    const persist = session.persist();
    await flush();
    assert.equal(world.contexts[0]!.storageAttempts, 0, 'persist waited for the read');
    gate.resolve();
    assert.equal(await read, 'held');
    await persist;
    assert.deepEqual(world.contexts[0]!.storageStates, [statePath]);
    await session.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- idle and shutdown -----------------------------------------------------------------------

test('idle release waits until no read is active or queued', async () => {
  const world = new FakeWorld();
  const gate = new Deferred<void>();
  const entered = new Deferred<void>();
  world.onPageCall = call => {
    if (call.source.includes('"one"')) {
      entered.resolve();
      void gate.promise.then(call.run).then(call.settle, call.fail);
      return;
    }
    void call.run().then(call.settle, call.fail);
  };
  const session = sessionOf(world, { idleTimeoutMs: 20, maxConcurrentReads: 1 });
  const first = readValue(session, 'one');
  await entered.promise;
  const second = readValue(session, 'two'); // queued behind the only slot
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(world.browsers[0]!.disconnected, false, 'idle must not close under an active or queued read');
  gate.resolve();
  assert.equal(await first, 'one');
  assert.equal(await second, 'two');
  await new Promise(resolve => setTimeout(resolve, 50));
  await flush();
  assert.equal(world.browsers[0]!.disconnected, true, 'idle released after both reads finished');
  await session.close();
});

test('an idle session releases its resources and a later read reattaches', async () => {
  const world = new FakeWorld();
  const session = sessionOf(world, { idleTimeoutMs: 20 });
  await readValue(session, 'one');
  await world.browserClosed.promise;
  await flush();
  assert.equal(world.browsers[0]!.disconnected, true);

  assert.equal(await readValue(session, 'two'), 'two');
  assert.equal(world.connects, 2, 'the next read rebuilt the connection');
  await session.close();
});

test('an idle registry entry is retired and a later caller gets a fresh instance', async () => {
  const world = new FakeWorld();
  const key = `idle-${Math.random()}`;
  const optionsForIdle = options(world, { idleTimeoutMs: 20 });
  const first = sessionFor(key, optionsForIdle);
  assert.equal(await readValue(first, 'one'), 'one');
  await world.browserClosed.promise;
  await flush();
  assert.equal(first.isClosed, true, 'the evicted instance is retired');
  await assert.rejects(readValue(first, 'stale'), (error: unknown) => (error as SearchError).kind === 'cancelled');
  const second = sessionFor(key, optionsForIdle);
  assert.notEqual(second, first, 'the idle entry was dropped instead of accumulating');
  assert.equal(await readValue(second, 'two'), 'two', 'the fresh instance is the only queue for that key');
  await second.close();
  await closeBrowserSessions();
});

test('a read queued while an idle session is dropping keeps the same registry entry', async () => {
  const world = new FakeWorld();
  const key = `idle-drop-${Math.random()}`;
  const optionsForIdle = options(world, { idleTimeoutMs: 20 });
  const session = sessionFor(key, optionsForIdle);
  await readValue(session, 'one');

  const entered = new Deferred<void>();
  const gate = new Deferred<void>();
  world.browsers[0]!.closeGate = gate;
  world.onBrowserClose = () => entered.resolve();
  await entered.promise;

  const queued = readValue(session, 'two');
  await flush();
  gate.resolve();
  assert.equal(await queued, 'two');
  assert.equal(world.connects, 2, 'the same session reattached');
  assert.equal(sessionFor(key, optionsForIdle), session, 'the registry kept the session the read is using');
  await session.close();
  await closeBrowserSessions();
});

test('close waits for in-flight reads, drops only its own connection, and is idempotent', async () => {
  const world = new FakeWorld();
  const gate = new Deferred<void>();
  const entered = new Deferred<void>();
  world.onPageCall = call => {
    entered.resolve();
    void gate.promise.then(call.run).then(call.settle, call.fail);
  };
  const session = sessionOf(world);
  const read = readValue(session, 'held');
  await entered.promise;

  let closed = false;
  const closing = Promise.all([session.close(), session.close()]).then(() => {
    closed = true;
  });
  await flush();
  assert.equal(closed, false, 'close waited for the read');
  gate.resolve();
  assert.equal(await read, 'held');
  await closing;
  assert.equal(closed, true);
  assert.equal(world.browsers[0]!.disconnected, true);
  assert.equal(world.browsers[0]!.closeCalls, 1);

  await session.close();
  assert.equal(world.browsers[0]!.closeCalls, 1, 'a repeated close does nothing');
});

test('close rejects queued reads and settles the in-flight one', async () => {
  const world = new FakeWorld();
  const entered = new Deferred<void>();
  world.onPageCall = call => {
    entered.resolve();
    // Never settles; only the forced teardown can end it.
    void call;
  };
  const session = sessionOf(world, { closeTimeoutMs: 20, maxConcurrentReads: 1 });
  const running = session.read(reader => reader.evaluate<string>('async () => "A"')).then(
    () => undefined,
    (error: unknown) => error,
  );
  await entered.promise;
  const queued = readValue(session, 'B').then(
    () => undefined,
    (error: unknown) => error,
  );
  await session.close();
  const [runningError, queuedError] = await Promise.all([running, queued]);
  assert.ok(runningError instanceof SearchError);
  assert.equal(runningError.kind, 'cancelled');
  assert.ok(queuedError instanceof SearchError);
  assert.equal(queuedError.kind, 'cancelled');
  assert.equal(world.pages[0]!.calls.some(call => call.source.includes('"B"')), false, 'the queued read never ran');
  await session.close();
});

test('close reclaims a stuck read after its bounded wait and reports cancelled', async () => {
  const world = new FakeWorld();
  const entered = new Deferred<void>();
  world.onPageCall = call => {
    entered.resolve();
    // Never settles; only the forced connection close can end it.
    void call;
  };
  const session = sessionOf(world, { closeTimeoutMs: 20 });
  const read = session.read(reader => reader.evaluate<string>('async () => "stuck"')).then(
    () => undefined,
    (error: unknown) => error,
  );
  await entered.promise;
  await session.close();
  assert.equal(world.browsers[0]!.disconnected, true, 'the connection was forced closed');
  const readError = await read;
  assert.ok(readError instanceof SearchError);
  assert.equal(readError.kind, 'cancelled', 'the forced phase reports cancellation, not a protocol failure');
  await session.close();
});

test('a connection that resolves after close is closed, not written into the session', async () => {
  const world = new FakeWorld();
  const gate = new Deferred<void>();
  const entered = new Deferred<void>();
  world.connectGate = gate;
  world.onConnect = () => entered.resolve();
  const session = sessionOf(world, { closeTimeoutMs: 20 });
  const read = readValue(session, 'late').then(
    () => undefined,
    (error: unknown) => error,
  );
  await entered.promise;
  await session.close();
  assert.equal(world.connects, 0, 'the attach had not returned yet');

  gate.resolve();
  await flush();
  assert.equal(world.connects, 1);
  assert.equal(world.browsers[0]!.disconnected, true, 'the late connection was closed');
  assert.equal(world.contexts.length, 0, 'no context was created on the late connection');
  const readError = await read;
  assert.ok(readError instanceof SearchError);
  assert.equal(readError.kind, 'cancelled');
});

test('a context that resolves after close is closed, not handed to the read', async () => {
  const world = new FakeWorld();
  const gate = new Deferred<void>();
  const entered = new Deferred<void>();
  world.newContextGate = gate;
  world.onNewContext = () => entered.resolve();
  const session = sessionOf(world, { closeTimeoutMs: 20 });
  const read = readValue(session, 'late').then(
    () => undefined,
    (error: unknown) => error,
  );
  await entered.promise;
  await session.close();
  assert.equal(world.contexts.length, 0, 'the late context had not been created yet');

  gate.resolve();
  await flush();
  assert.equal(world.contexts.length, 1, 'the gated newContext resolved late');
  assert.equal(world.contexts[0]!.closed, true, 'the late context was closed immediately');
  const readError = await read;
  assert.ok(readError instanceof SearchError);
  assert.equal(readError.kind, 'cancelled');
});

test('closeTimeoutMs bounds the whole shutdown rather than each phase', async () => {
  const world = new FakeWorld();
  const entered = new Deferred<void>();
  world.onPageCall = call => {
    entered.resolve();
    void call;
  };
  const session = sessionOf(world, { closeTimeoutMs: 100 });
  const read = session.read(reader => reader.evaluate<string>('async () => "stuck"')).then(
    () => undefined,
    (error: unknown) => error,
  );
  await entered.promise;

  const gate = new Deferred<void>();
  world.browsers[0]!.closeGate = gate;
  const started = Date.now();
  await session.close();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 170, `shutdown took ${elapsed}ms; the total budget should be near 100ms`);

  gate.resolve();
  await flush();
  const readError = await read;
  assert.ok(readError instanceof SearchError);
  assert.equal(readError.kind, 'cancelled');
});

test('close stays bounded even when the browser connection refuses to close', async () => {
  const world = new FakeWorld();
  const session = sessionOf(world, { closeTimeoutMs: 20 });
  await readValue(session, 'one');
  const gate = new Deferred<void>();
  world.browsers[0]!.closeGate = gate;

  await session.close();
  assert.equal(session.isClosed, true, 'close returned despite the wedged connection');
  assert.equal(world.browsers[0]!.closeCalls, 1, 'the forced teardown was started');

  gate.resolve();
  await flush();
  assert.equal(world.browsers[0]!.disconnected, true, 'the teardown finished in the background');
});

test('closeBrowserSessions truncates synchronously so a later caller gets a new session', async () => {
  const world = new FakeWorld();
  const key = `registry-${Math.random()}`;
  const optionsForRegistry = options(world);
  const first = sessionFor(key, optionsForRegistry);
  assert.equal(await readValue(first, 'one'), 'one');

  const closing = closeBrowserSessions();
  const second = sessionFor(key, optionsForRegistry);
  assert.notEqual(second, first, 'a caller during shutdown does not join the closing session');
  await closing;
  assert.equal(first.isClosed, true);
  assert.equal(second.isClosed, false);
  await second.close();
});

test('an explicit close refuses new reads', async () => {
  const world = new FakeWorld();
  const session = sessionOf(world);
  await readValue(session, 'one');
  await session.close();
  await assert.rejects(readValue(session, 'two'), (error: unknown) => (error as SearchError).kind === 'cancelled');
  assert.equal(world.connects, 1);
});

test('maxConcurrentReads is validated instead of silently clamped', () => {
  const world = new FakeWorld();
  for (const value of [0, 9, 1.5, Number.NaN]) {
    assert.throws(
      () => new BrowserSession(options(world, { maxConcurrentReads: value })),
      (error: unknown) => {
        assert.ok(error instanceof SearchError);
        assert.equal(error.kind, 'configuration');
        assert.match(error.message, /maxConcurrentReads/);
        return true;
      },
    );
  }
  for (const value of [1, 2, 8]) {
    const session = new BrowserSession(options(world, { maxConcurrentReads: value }));
    assert.ok(session);
  }
  const passedThrough = optionsOf({ wsEndpoint: 'ws://127.0.0.1:3000/xhs', timeoutMs: 1_000, signal: new AbortController().signal, maxConcurrentReads: 3 });
  assert.equal(passedThrough.maxConcurrentReads, 3);
});
