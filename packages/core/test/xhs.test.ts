// Xiaohongshu reads, exercised against an injected transaction session: the browser belongs to the
// user, so these tests assert the contract around it — one transaction per read, which page
// operations run, how the page's own state is projected, and how refusals are scoped.
//
// The page itself is faked here. Nothing in this file contacts Xiaohongshu.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchError } from '../src/transport.js';
import { catalog } from '../src/catalog.js';
import type { BrowserReader, BrowserTab, TabHandle, TabResponse } from '../src/browser.js';
import { connectFailure } from '../src/browser.js';
import {
  DEFAULT_STATE_PATH,
  fetchXhsComments,
  fetchXhsNote,
  optionsOf,
  readXhsNote,
  readXhsSearch,
  resolveTarget,
  searchXhs,
} from '../src/xhs/index.js';

interface Call { script: string }

const handle = (overrides: Partial<TabHandle> = {}): TabHandle => ({
  tabId: 'tab-1',
  generation: 1,
  contentGeneration: 3,
  path: '/search_result',
  ...overrides,
});

const signedIn = { hasState: true, guest: false, loggedIn: true, hasUserInfo: true, feedCount: 2, cardCount: 2, ready: 'complete' };
const guest = { hasState: true, guest: true, loggedIn: false, hasUserInfo: true, feedCount: 0, cardCount: 0, ready: 'complete' };
const identityMissing = { hasState: true, guest: null, loggedIn: null, hasUserInfo: false, feedCount: null, cardCount: 0, ready: 'complete' };

/**
 * A stand-in for one tab transaction. Scripts are answered by matching on the probe they contain,
 * which keeps the test about the reader's decisions rather than about script text.
 */
function fakeTab(answers: {
  probe?: unknown;
  candidates?: unknown;
  detail?: unknown;
  commentsState?: unknown;
  check?: unknown;
  searchEnvelope?: unknown;
  noteEnvelope?: unknown;
  commentEnvelope?: unknown;
}) {
  const navigations: string[] = [];
  const clicks: string[] = [];
  const scrolls: number[] = [];
  let retained = false;
  const waiters: Array<(response: TabResponse) => void> = [];

  const evaluate = async <T,>(script: string): Promise<T> => {
    if (script.includes('data-note-id') && script.includes('obscured')) return (answers.candidates ?? []) as T;
    if (script.includes('clickable')) return (answers.check ?? { found: true, clickable: true }) as T;
    if (script.includes('noteDetailMap') && script.includes('imageUrls')) return (answers.detail ?? { found: false }) as T;
    if (script.includes('firstRequestFinish')) return (answers.commentsState ?? { comments: [], hasMore: false, cursor: '', loaded: true, loading: false }) as T;
    return (answers.probe ?? signedIn) as T;
  };

  const respond = async (body: unknown): Promise<TabResponse> => ({ url: 'https://www.xiaohongshu.com/api', status: 200, json: async () => body });

  const tab: BrowserTab = {
    get released() {
      return false;
    },
    id: 'tab-1',
    contentGeneration: 3,
    path: '/search_result',
    handle: () => handle(),
    evaluate,
    navigate: async url => {
      navigations.push(url);
    },
    expectResponse: (match): Promise<TabResponse> => {
      // The search read arms one waiter before navigating; the note read arms one before acting.
      if (answers.searchEnvelope !== undefined && match(new URL('https://so.xiaohongshu.com/api/sns/web/v2/search/notes'))) {
        return respond(answers.searchEnvelope);
      }
      if (answers.commentEnvelope !== undefined) return respond(answers.commentEnvelope);
      return respond(answers.noteEnvelope ?? { success: true, data: { items: [] } });
    },
    clickTarget: async target => {
      clicks.push(target);
    },
    scrollBy: async (_selector, distance) => {
      scrolls.push(distance);
      return distance;
    },
    retain: () => {
      retained = true;
    },
  };
  return {
    tab,
    navigations,
    clicks,
    scrolls,
    retained: () => retained,
    waiters,
  };
}

function fakeSession(tab: BrowserTab) {
  let transactions = 0;
  let closed = 0;
  let persisted = 0;
  let handleUsed: TabHandle | undefined;
  let receivedSignal: AbortSignal | undefined;
  const session = {
    async read<T>(_run: (reader: BrowserReader) => Promise<T>, _signal?: AbortSignal): Promise<T> {
      throw new Error('the page-driven reader must not use the script transaction path');
    },
    async readTab<T>(fn: (tab: BrowserTab) => Promise<T>, options: { handle?: TabHandle; signal?: AbortSignal } = {}): Promise<T> {
      transactions += 1;
      receivedSignal = options.signal;
      handleUsed = options.handle;
      return fn(tab);
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
    closed: () => closed,
    persisted: () => persisted,
    transactions: () => transactions,
    handleUsed: () => handleUsed,
    signal: () => receivedSignal,
  };
}

const ctx = (session: unknown, extra: Record<string, unknown> = {}) => ({
  wsEndpoint: 'ws://127.0.0.1:3000/xhs',
  timeoutMs: 1_000,
  siteUrl: 'https://www.xiaohongshu.com',
  signal: new AbortController().signal,
  browser: session as never,
  ...extra,
});

const searchEnvelope = {
  success: true,
  data: {
    has_more: true,
    items: [
      { id: 'n1', model_type: 'note', note_card: { display_title: '标题一', user: { nickname: '作者' }, interact_info: { liked_count: 12 } } },
      { id: 'n2', model_type: 'note', note_card: { display_title: '标题二', user: { nickname: '作者二' }, interact_info: { liked_count: 3 } } },
    ],
  },
};

const candidate = (noteId: string, label = '标题') => ({ noteId, path: `/explore/${noteId}`, label, role: label ? 'title' : 'cover', position: 0, obscured: false });

const detailProbe = (overrides: Record<string, unknown> = {}) => ({
  found: true,
  idMatches: true,
  title: '标题',
  desc: '正文',
  author: '作者',
  authorId: 'u1',
  likes: '12',
  collects: '1',
  comments: '2',
  shares: '0',
  publishedAt: '1700000000',
  tags: ['咖啡'],
  imageUrls: ['https://img/1.jpg'],
  commentCount: 2,
  commentsLoaded: true,
  commentsHasMore: false,
  commentsCursor: '',
  ...overrides,
});

test('xiaohongshu is a self-hosted browser backend with no credential requirement', () => {
  const entry = catalog.find(item => item.id === 'xiaohongshu');
  assert.ok(entry, 'the backend must exist in the catalog');
  assert.deepEqual(entry!.modes.map(mode => mode.mode), ['browser']);
  assert.equal(entry!.modes[0]!.tier, 'self-hosted');
  assert.match(entry!.modes[0]!.limits.en, /browser you host/);
});

test('a search drives the real search address instead of calling the API', async () => {
  const page = fakeTab({ candidates: [candidate('n1'), candidate('n2')], searchEnvelope });
  const session = { readTab: async <T,>(fn: (tab: BrowserTab) => Promise<T>) => fn(page.tab) };
  const result = await readXhsSearch({ query: '咖啡 手冲' }, ctx(session));
  assert.equal(page.navigations.length, 1, 'the page is opened once');
  assert.match(page.navigations[0]!, /\/search_result\?keyword=/);
  assert.match(decodeURIComponent(page.navigations[0]!), /咖啡 手冲/);
  assert.equal(result.notes.length, 2);
  assert.equal(result.notes[0]!.url, 'https://www.xiaohongshu.com/explore/n1');
  assert.equal(result.candidates.length, 2, 'the rendered cards become clickable references');
  assert.equal(page.retained(), true, 'the tab is kept so its candidates stay usable');
});

test('a search keeps a card that has no title, because text is not required', async () => {
  const page = fakeTab({ candidates: [candidate('n1', '')], searchEnvelope: { success: true, data: { items: [{ id: 'n1', model_type: 'note', note_card: { user: {}, interact_info: {} } }] } } });
  const session = { readTab: async <T,>(fn: (tab: BrowserTab) => Promise<T>) => fn(page.tab) };
  const result = await readXhsSearch({ query: 'q' }, ctx(session));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.label, '', 'a cover link carries no text and is still a candidate');
  assert.equal(result.candidates[0]!.role, 'cover');
});

test('search results stay citeable and never carry the note token', async () => {
  const page = fakeTab({ candidates: [candidate('n1')], searchEnvelope });
  const session = { readTab: async <T,>(fn: (tab: BrowserTab) => Promise<T>) => fn(page.tab) };
  const sources = await searchXhs({ query: 'q', maxResults: 5 }, ctx(session));
  assert.equal(sources.length, 2);
  assert.match(sources[0]!.summary!, /作者/);
  assert.doesNotMatch(JSON.stringify(sources), /xsec_token/i);
});

test('a malformed search payload is a failure, not an empty result', async () => {
  const page = fakeTab({ candidates: [], searchEnvelope: { success: true, data: { no_items_here: true } } });
  const session = { readTab: async <T,>(fn: (tab: BrowserTab) => Promise<T>) => fn(page.tab) };
  await assert.rejects(readXhsSearch({ query: 'q' }, ctx(session)), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.kind, 'protocol');
    return true;
  });
});

test('a search whose response arrived but whose cards never rendered fails instead of returning nothing', async () => {
  const page = fakeTab({ candidates: [], searchEnvelope });
  const session = { readTab: async <T,>(fn: (tab: BrowserTab) => Promise<T>) => fn(page.tab) };
  await assert.rejects(readXhsSearch({ query: 'q' }, ctx({ ...session }, { timeoutMs: 150 })), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    // A result set that did render nothing is only valid when the payload said it was empty.
    assert.equal(error.kind, 'timeout');
    return true;
  });
});

test('an explicitly empty result set is accepted as an empty search', async () => {
  const page = fakeTab({ candidates: [], searchEnvelope: { success: true, data: { items: [] } } });
  const session = { readTab: async <T,>(fn: (tab: BrowserTab) => Promise<T>) => fn(page.tab) };
  const result = await readXhsSearch({ query: 'q' }, ctx(session));
  assert.equal(result.notes.length, 0);
  assert.equal(result.candidates.length, 0);
});

test('a guest page refuses the read before any page operation', async () => {
  const page = fakeTab({ probe: guest });
  const session = { readTab: async <T,>(fn: (tab: BrowserTab) => Promise<T>) => fn(page.tab) };
  await assert.rejects(readXhsSearch({ query: 'q' }, ctx(session)), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.kind, 'authentication');
    assert.equal(error.scope, 'site', 'a guest session closes the gate for the whole site');
    return true;
  });
  assert.equal(page.navigations.length, 0, 'no page was opened');
});

test('a missing identity payload is refused instead of being read as signed in', async () => {
  const page = fakeTab({ probe: identityMissing });
  const session = { readTab: async <T,>(fn: (tab: BrowserTab) => Promise<T>) => fn(page.tab) };
  await assert.rejects(readXhsSearch({ query: 'q' }, ctx(session)), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    // The old negated truthiness test turned a missing answer into "guest: false" and passed.
    assert.equal(error.kind, 'protocol');
    return true;
  });
});

test('a note is opened by clicking the card the search listed', async () => {
  const page = fakeTab({ detail: detailProbe(), noteEnvelope: { success: true, data: { items: [{}] } } });
  const fake = fakeSession(page.tab);
  const read = await readXhsNote({ id: 'n1', handle: handle() }, ctx(fake.session));
  assert.equal(read.note.id, 'n1');
  assert.equal(page.clicks.length, 1, 'the card was clicked, not fetched');
  assert.match(page.clicks[0]!, /data-note-id="n1"/);
  assert.equal(page.navigations.length, 0, 'a listed card is clicked, not navigated to');
  assert.equal(fake.handleUsed()?.tabId, 'tab-1', 'the transaction joined the tab that listed the card');
});

test('a covered card is not clicked', async () => {
  const page = fakeTab({ check: { found: true, clickable: false }, detail: detailProbe() });
  const fake = fakeSession(page.tab);
  await assert.rejects(readXhsNote({ id: 'n1', handle: handle() }, ctx(fake.session)), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.match(error.message, /covered or hidden/);
    return true;
  });
  assert.equal(page.clicks.length, 0, 'nothing was clicked');
});

test('a card that is no longer on the page is a failure, not a different click', async () => {
  const page = fakeTab({ check: { found: false, clickable: false }, detail: detailProbe() });
  const fake = fakeSession(page.tab);
  await assert.rejects(readXhsNote({ id: 'n1', handle: handle() }, ctx(fake.session)), /no longer on the page/);
  assert.equal(page.clicks.length, 0);
});

test('a share link opens the target directly', async () => {
  const page = fakeTab({ detail: detailProbe({ title: '来自链接' }), noteEnvelope: { success: true, data: { items: [{}] } } });
  const fake = fakeSession(page.tab);
  const read = await readXhsNote({ url: 'https://www.xiaohongshu.com/explore/n1?xsec_token=TOKEN123&xsec_source=pc_feed' }, ctx(fake.session));
  assert.equal(page.navigations.length, 1);
  assert.match(page.navigations[0]!, /xsec_token=TOKEN123/, 'the share link keeps the token it carries');
  assert.equal(read.note.title, '来自链接');
  assert.equal(page.clicks.length, 0, 'a share link does not depend on a listed card');
});

test('the note read reports the note the page actually opened', async () => {
  const page = fakeTab({ detail: detailProbe({ idMatches: false }), noteEnvelope: { success: true, data: { items: [{}] } } });
  const fake = fakeSession(page.tab);
  await assert.rejects(readXhsNote({ id: 'n1', handle: handle() }, ctx(fake.session)), /different note/);
});

test('the note carries its picture list internally', async () => {
  const page = fakeTab({ detail: detailProbe(), noteEnvelope: { success: true, data: { items: [{}] } } });
  const fake = fakeSession(page.tab);
  const note = await fetchXhsNote({ id: 'n1', handle: handle() }, ctx(fake.session));
  assert.deepEqual(note.imageUrls, ['https://img/1.jpg'], 'the host needs the list to fetch the bytes');
});

test('comments come from the page the note read already loaded, in one transaction', async () => {
  const page = fakeTab({
    detail: detailProbe(),
    commentsState: {
      comments: [{ id: 'c1', author: 'a', content: 'hi', likes: '2', replies: '0', ipLocation: '', liked: false }],
      hasMore: false,
      cursor: 'CUR1',
      loaded: true,
      loading: false,
    },
    noteEnvelope: { success: true, data: { items: [{}] } },
  });
  const fake = fakeSession(page.tab);
  const read = await readXhsNote({ id: 'n1', handle: handle(), withComments: true }, ctx(fake.session));
  assert.equal(fake.transactions(), 1, 'the detail and its comments are one transaction');
  assert.equal(read.comments?.comments.length, 1);
  assert.equal(page.scrolls.length, 0, 'no scroll was needed: the page already had them');
});

test('asking for comments requests no extra page when the page already reported none left', async () => {
  const page = fakeTab({
    detail: detailProbe(),
    commentsState: { comments: [{ id: 'c1', author: 'a', content: 'hi', likes: '0', replies: '0', ipLocation: '', liked: false }], hasMore: false, cursor: 'C', loaded: true, loading: false },
    noteEnvelope: { success: true, data: { items: [{}] } },
  });
  const fake = fakeSession(page.tab);
  const result = await fetchXhsComments({ id: 'n1', handle: handle(), limit: 50 }, ctx(fake.session));
  assert.equal(result.comments.length, 1);
  assert.equal(page.scrolls.length, 0);
});

test('a note read without comments does not ask for them', async () => {
  const page = fakeTab({ detail: detailProbe(), noteEnvelope: { success: true, data: { items: [{}] } } });
  const fake = fakeSession(page.tab);
  const read = await readXhsNote({ id: 'n1', handle: handle() }, ctx(fake.session));
  assert.equal(read.comments, undefined, 'comments are omitted unless they were asked for');
  assert.equal(page.scrolls.length, 0);
});

test('a note id is only accepted together with a reference from a search', () => {
  assert.deepEqual(resolveTarget({ url: 'https://www.xiaohongshu.com/explore/abc123?xsec_token=T' }), { id: 'abc123' });
  assert.deepEqual(resolveTarget({ id: 'abc123', handle: handle() }), { id: 'abc123', handle: handle() });
  assert.throws(() => resolveTarget({ id: 'abc123' }), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.kind, 'configuration');
    // A token is not evidence that the note belongs to this session, so a bare id is not enough.
    assert.match(error.message, /share link|reference/);
    return true;
  });
  assert.throws(() => resolveTarget({ url: 'https://[unparseable' }), /not a Xiaohongshu note URL/);
});

test('the xhs session policy is read-only: it loads the state file but never writes the keeper file', () => {
  const base = { wsEndpoint: 'ws://127.0.0.1:3000/xhs', timeoutMs: 1_000, signal: new AbortController().signal };
  const options = optionsOf(base);
  assert.equal(options.statePolicy, 'read-only');
  assert.equal(options.statePath, process.env.XHS_STATE_PATH ?? DEFAULT_STATE_PATH);
  assert.equal(optionsOf({ ...base, statePath: '/tmp/xhs-state.json' }).statePath, '/tmp/xhs-state.json');
  assert.equal(optionsOf({ ...base, maxConcurrentReads: 3 }).maxConcurrentReads, 3);
  assert.equal('maxConcurrentReads' in optionsOf(base), false, 'the default is left to the browser session');
});

test('an empty query is a configuration error before any browser work', async () => {
  await assert.rejects(readXhsSearch({ query: '   ' }, ctx({})), /empty/);
});

test('connection failures explain which side to fix', () => {
  const options = { wsEndpoint: 'ws://127.0.0.1:3000/xhs', siteUrl: 'https://www.xiaohongshu.com', timeoutMs: 1000 };
  assert.match(connectFailure(new Error('version mismatch'), options).message, /protocol version/);
  assert.equal(connectFailure(new Error('401 Unauthorized'), options).kind, 'authentication');
  assert.equal(connectFailure(new Error('ECONNREFUSED'), options).kind, 'network');
});

test('a missing endpoint is a configuration error before any browser work', async () => {
  await assert.rejects(searchXhs({ query: 'q', maxResults: 3 }, { wsEndpoint: '', timeoutMs: 1000, signal: new AbortController().signal }), /Playwright endpoint/);
});
