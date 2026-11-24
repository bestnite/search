import { homedir } from 'node:os';
import { join } from 'node:path';
import { SearchError } from '../transport.js';
import type { Source } from '../types.js';
import {
  type BrowserSession,
  type BrowserTab,
  type TabHandle,
  DEFAULT_MAX_CONCURRENT_READS,
  sessionFor,
  type BrowserSessionOptions,
} from '../browser.js';
import { candidatesScript, candidateCheckScript, commentsStateScript, noteDetailScript, searchPath, stateProbeScript } from './scripts.js';

/**
 * Xiaohongshu reads through the user's own browser, driven the way a person drives it.
 *
 * A read opens the page it needs, clicks the card it was pointed at, and scrolls the comment list
 * when more comments were asked for. Every request therefore comes from the site itself, carrying
 * the search context the site minted, instead of being assembled here.
 *
 * Everything here is a read: nothing is published, liked, followed or marked as read.
 */
export interface XhsContext {
  wsEndpoint: string;
  token?: string;
  siteUrl?: string;
  /** File holding the signed-in session, so a fresh process starts already logged in. */
  statePath?: string;
  timeoutMs: number;
  signal: AbortSignal;
  /**
   * Local admission bound for this site (1 through 8). It bounds active transactions, not open
   * tabs; it is not a Xiaohongshu quota. Hosts expose `browser.maxConcurrentReads`, and it is part
   * of the session identity, so a note read has to pass the same value to join the search's session.
   */
  maxConcurrentReads?: number;
  /**
   * Injected in tests; production uses the kept browser session. Only the transaction entry points
   * are exposed: a read must not be able to close the connection or write the session file.
   */
  browser?: Pick<BrowserSession, 'read' | 'readTab'>;
}

/**
 * Default session file, kept beside the browser container's volume so the session the container
 * saves is the session a read starts from. Override with the statePath option or XHS_STATE_PATH.
 */
export const DEFAULT_STATE_PATH = join(homedir(), '.config', 'dsh-search', 'browser', 'state.json');

export const DEFAULT_SITE_URL = 'https://www.xiaohongshu.com';

export interface XhsNoteSummary {
  id: string;
  title: string;
  author: string;
  likes: string;
  url: string;
}

/** A card the search rendered, as a reference the caller may later act on. */
export interface XhsCandidate {
  noteId: string;
  path: string;
  label: string;
  role: 'title' | 'cover';
  position: number;
  obscured: boolean;
}

export interface XhsSearchResult {
  notes: XhsNoteSummary[];
  /** The cards the page actually rendered, in render order; each is a target that can be clicked. */
  candidates: XhsCandidate[];
  /** Opaque reference to the tab that rendered these cards; only usable while that tab lives. */
  handle: TabHandle;
}

export interface XhsNote {
  id: string;
  title: string;
  desc: string;
  author: string;
  likes: string;
  collects: string;
  comments: string;
  shares: string;
  publishedAt?: string;
  tags: string[];
  /**
   * Picture URLs in display order. These are signed and time-limited, so they stay inside the
   * process: hosts download or inline the bytes and must not put these strings in their output.
   */
  imageUrls: string[];
  url: string;
}

export interface XhsComment {
  id: string;
  author: string;
  content: string;
  likes: string;
  replies: string;
  ipLocation?: string;
}

export interface XhsCommentPage {
  comments: XhsComment[];
  hasMore: boolean;
  cursor?: string;
}

/** What a note read returns: the note plus, when asked for, the comments the page already had. */
export interface XhsNoteRead {
  note: XhsNote;
  comments?: XhsCommentPage;
}

/** A page probe answered with the fields a read needs; a missing field is `null`, never a default. */
interface StateProbe {
  hasState: boolean;
  guest: boolean | null;
  loggedIn: boolean | null;
  hasUserInfo: boolean;
  feedCount: number | null;
  cardCount: number;
  ready: string;
}

interface NoteDetailProbe extends XhsNote {
  found: boolean;
  idMatches: boolean;
  commentCount: number | null;
  commentsLoaded: boolean;
  commentsHasMore: boolean;
  commentsCursor: string;
}

interface CommentsProbe extends XhsCommentPage {
  loaded: boolean;
  loading: boolean;
}

const browserFor = (ctx: XhsContext): Pick<BrowserSession, 'read' | 'readTab'> => {
  if (ctx.browser) return ctx.browser;
  const options = optionsOf(ctx);
  // The key names everything that changes isolation: endpoint, token, site and session file.
  // Two callers with conflicting values must not silently share one session. The token stays
  // an in-memory key only; it is never logged.
  const key = JSON.stringify([
    'xhs',
    options.wsEndpoint,
    options.token ?? '',
    options.siteUrl,
    options.statePath ?? '',
    options.maxConcurrentReads ?? DEFAULT_MAX_CONCURRENT_READS,
  ]);
  return sessionFor(key, options);
};

export function optionsOf(ctx: XhsContext): BrowserSessionOptions {
  return {
    wsEndpoint: ctx.wsEndpoint,
    siteUrl: ctx.siteUrl ?? DEFAULT_SITE_URL,
    timeoutMs: ctx.timeoutMs,
    statePath: ctx.statePath ?? process.env.XHS_STATE_PATH ?? DEFAULT_STATE_PATH,
    // The keeper in the browser image is the only writer of this file. A read loads it but must
    // never save over the cookies the human just refreshed in the VNC window.
    statePolicy: 'read-only',
    ...(ctx.token ? { token: ctx.token } : {}),
    ...(ctx.maxConcurrentReads !== undefined ? { maxConcurrentReads: ctx.maxConcurrentReads } : {}),
  };
}

const guard = (ctx: XhsContext): void => {
  if (!ctx.wsEndpoint) throw new SearchError('configuration', 'The Xiaohongshu backend needs a Playwright endpoint. Set the browser endpoint option or XHS_WS_ENDPOINT to the URL the browser prints at startup.');
  if (ctx.signal.aborted) throw new SearchError('cancelled', 'The Xiaohongshu read was cancelled.');
};

/** Poll until `check` reports done, or the budget runs out. A slow page is a timeout, not a result. */
async function until<T>(check: () => Promise<T | undefined>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  for (;;) {
    if (signal.aborted) throw new SearchError('cancelled', 'The Xiaohongshu read was cancelled.');
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new SearchError('timeout', 'The Xiaohongshu page did not finish loading the data this read needs in time.');
}

/**
 * Identity gate. Only an explicit signed-in answer passes: a missing or malformed identity payload
 * is a failure, because treating "no answer" as "signed in" is what let a guest session send reads.
 */
function requireSignedIn(probe: StateProbe): void {
  if (!probe.hasState) {
    throw new SearchError('protocol', 'The Xiaohongshu page did not load its runtime, so no read was sent. Open xiaohongshu.com in that browser once.');
  }
  if (probe.guest === true) {
    throw new SearchError(
      'authentication',
      'Xiaohongshu reports this browser as a guest. Sign in once in the browser container VNC window; the next read reloads the saved session.',
    ).withScope('site');
  }
  if (probe.guest !== false) {
    throw new SearchError(
      'protocol',
      'The Xiaohongshu page did not report a usable identity, so no read was sent. Reload the site in that browser and ask again.',
    );
  }
}

/** Map a response status to a refusal, keeping a challenge site-wide and a subject refusal local. */
function refusalFor(status: number, what: string): SearchError {
  if (status === 401 || status === 406) {
    return new SearchError(
      'authentication',
      `Xiaohongshu refused the ${what} with HTTP ${status}, which means the session is not signed in or was challenged. Sign in again in that browser.`,
      status,
    ).withScope('site');
  }
  if (status === 403) {
    return new SearchError(
      'authentication',
      `Xiaohongshu denied the ${what} with HTTP 403. This note may be private, deleted, or not visible to this account.`,
      status,
    );
  }
  if (status === 429) return new SearchError('rate-limit', 'Xiaohongshu rate-limited this read; wait before asking again.', status);
  return new SearchError('protocol', `Xiaohongshu answered the ${what} with HTTP ${status}.`, status);
}

/** Read one JSON response, reporting a challenge by status and an unexpected body as a failure. */
async function readEnvelope(response: { status: number; json(): Promise<unknown> }, what: string): Promise<Record<string, unknown>> {
  if (response.status < 200 || response.status >= 300) throw refusalFor(response.status, what);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SearchError('protocol', `The Xiaohongshu ${what} response was not JSON.`);
  }
  if (!payload || typeof payload !== 'object') {
    throw new SearchError('protocol', `The Xiaohongshu ${what} response was not an object.`);
  }
  const envelope = payload as Record<string, unknown>;
  if (envelope.success === false) {
    const status = typeof envelope.code === 'number' ? envelope.code : undefined;
    const message = typeof envelope.msg === 'string' ? envelope.msg : 'no detail';
    if (/登录|login/i.test(message)) {
      throw new SearchError('authentication', 'Xiaohongshu says this browser is not signed in. Sign in again in that browser.').withScope('site');
    }
    throw new SearchError('protocol', `Xiaohongshu refused the ${what} (${message}).`, status);
  }
  const data = envelope.data;
  if (!data || typeof data !== 'object') throw new SearchError('protocol', `The Xiaohongshu ${what} response carried no data.`);
  return data as Record<string, unknown>;
}

const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Locate a listed card by its note id rather than by a class name: the site's class names are build
 * artifacts, while the id attribute is the identity the page itself uses.
 */
const candidateSelector = (noteId: string): string => `section[data-note-id="${noteId}"] a[href$="/${noteId}"]`;

/**
 * Read the search page the way a person reaches it: navigate to the address that carries the query,
 * let the page issue its own search request, and wait until both the response and the rendered cards
 * are there. Waiting on the response alone would hand back a result set with no candidates.
 *
 * `retain` keeps the tab in the session pool so the returned handle stays usable. It is on by
 * default because the caller receives exactly that handle; a caller that only wants sources turns it
 * off, so its tabs are closed instead of accumulating.
 */
export async function readXhsSearch(input: { query: string; retain?: boolean }, ctx: XhsContext): Promise<XhsSearchResult> {
  guard(ctx);
  const query = input.query.trim();
  if (query === '') throw new SearchError('configuration', 'The Xiaohongshu search query was empty.');
  return browserFor(ctx).readTab(async tab => {
    const probe = await tab.evaluate<StateProbe>(stateProbeScript());
    requireSignedIn(probe);

    // Arm the collector before navigating: the page fires this request while it loads, so a waiter
    // registered afterwards would miss it.
    const response = tab.expectResponse(url => url.pathname === '/api/sns/web/v2/search/notes', ctx.timeoutMs);
    response.catch(() => undefined);
    await tab.navigate(`${ctx.siteUrl ?? DEFAULT_SITE_URL}${searchPath(query)}`, ctx.timeoutMs);

    const data = await readEnvelope(await response, 'search');
    const items = data.items;
    if (!Array.isArray(items)) throw new SearchError('protocol', 'The Xiaohongshu search response carried no item list.');

    // The response and the DOM settle separately, so the candidates are awaited on their own.
    const candidates = await until(async () => {
      const found = await tab.evaluate<XhsCandidate[]>(candidatesScript());
      if (found.length > 0) return found;
      // An empty list is only accepted when the response itself said the search had no results.
      return items.length === 0 ? [] : undefined;
    }, ctx.timeoutMs, ctx.signal);

    const byId = new Map<string, XhsCandidate>();
    for (const candidate of candidates) {
      if (!candidate.noteId || byId.has(candidate.noteId)) continue;
      byId.set(candidate.noteId, candidate);
    }

    const notes: XhsNoteSummary[] = [];
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      if (item.model_type !== 'note') continue;
      const id = stringOf(item.id);
      if (id === '') continue;
      const card = (item.note_card ?? {}) as Record<string, unknown>;
      const user = (card.user ?? {}) as Record<string, unknown>;
      const stats = (card.interact_info ?? {}) as Record<string, unknown>;
      notes.push({
        id,
        title: stringOf(card.display_title) || stringOf(card.title),
        author: stringOf(user.nickname) || stringOf(user.nick_name),
        likes: stats.liked_count === undefined || stats.liked_count === null ? '0' : String(stats.liked_count),
        url: `${DEFAULT_SITE_URL}/explore/${id}`,
      });
    }

    if (input.retain !== false) tab.retain();
    const handle = tab.handle();
    // Remember which notes this search listed, so "read the note I just saw" can act on the tab
    // without the caller ever holding a token or a private handle.
    if (input.retain !== false) rememberListed(notes, handle);
    return { notes, candidates: [...byId.values()], handle };
  }, { signal: ctx.signal });
}

/** Search as the engine sees it: citeable sources, one per note. No tab is kept for these. */
export async function searchXhs(input: { query: string; maxResults: number; sort?: string }, ctx: XhsContext): Promise<Source[]> {
  const result = await readXhsSearch({ query: input.query, retain: false }, ctx);
  return result.notes
    .slice(0, Math.min(Math.max(input.maxResults, 1), 40))
    .map(note => ({
      url: note.url,
      title: note.title === '' ? `小红书 note by ${note.author}` : note.title,
      summary: `${note.author} · ${note.likes} likes`,
    }));
}

/** Everything a note read needs to act on, resolved before a tab is taken. */
interface NoteTarget {
  id: string;
  handle?: TabHandle;
}

/**
 * Note ids that the most recent searches actually listed, with the tab handle that can act on them.
 *
 * A caller sees only a public result (a note URL and a title), so it cannot supply the private
 * handle itself. This table is what lets "search, then read one of the notes that came back" work
 * without handing a token to the caller and without accepting an arbitrary id.
 *
 * It is keyed by note id and holds the handle, which carries the browser generation and the content
 * generation. An entry whose generation has moved is refused when it is used, so a stale row can
 * never turn into a click on different content. Entries are replaced by later searches and bounded,
 * so the table cannot grow without limit.
 */
const listedNotes = new Map<string, TabHandle>();
const LISTED_NOTE_LIMIT = 200;

function rememberListed(notes: readonly { id: string }[], handle: TabHandle): void {
  for (const note of notes) {
    if (!note.id) continue;
    listedNotes.set(note.id, handle);
  }
  while (listedNotes.size > LISTED_NOTE_LIMIT) {
    const oldest = listedNotes.keys().next();
    if (oldest.done) break;
    listedNotes.delete(oldest.value);
  }
}

/**
 * Forget the listed notes a handle can no longer act on. Called when a read proves the tab is gone,
 * so a later "read that note by id" reports a stale reference instead of retrying a dead one.
 */
function forgetListedFrom(handle: TabHandle): void {
  for (const [id, entry] of listedNotes) {
    if (entry.generation !== handle.generation || entry.tabId === handle.tabId) listedNotes.delete(id);
  }
}

/** Whether this failure means the handle is dead rather than the read being refused. */
const isStaleHandle = (error: unknown): boolean =>
  error instanceof SearchError && error.kind === 'protocol' && /gone|stale|closed|earlier browser session/i.test(error.message);

/**
 * A note is addressed either by its share link, which opens the target directly, or by an id that a
 * search in this process listed. A bare id that no search produced is refused: nothing can prove it
 * belongs to a note this session may read, and a token would not prove it either.
 */
/**
 * Drop every remembered listing. Exposed for hosts that replace their browser session wholesale, and
 * for tests that must not inherit what an earlier case listed.
 */
export function clearListedNotes(): void {
  listedNotes.clear();
}

export function resolveTarget(input: { url?: string; id?: string; handle?: TabHandle }): NoteTarget {
  const raw = (input.url ?? input.id ?? '').trim();
  if (raw === '') throw new SearchError('configuration', 'Pass a note URL or a note id.');
  if (raw.includes('/')) {
    try {
      const url = new URL(raw);
      const match = /\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/.exec(url.pathname);
      const id = match?.[1] ?? url.pathname.split('/').filter(Boolean).pop() ?? '';
      if (id === '') throw new SearchError('configuration', `Could not read a note id from "${raw}".`);
      // A share link may also reuse a listed tab, which keeps the click path available.
      const listed = input.handle ?? listedNotes.get(id);
      return { id, ...(listed ? { handle: listed } : {}) };
    } catch (error) {
      if (error instanceof SearchError) throw error;
      throw new SearchError('configuration', `"${raw}" is not a Xiaohongshu note URL.`);
    }
  }
  const handle = input.handle ?? listedNotes.get(raw);
  if (!handle) {
    throw new SearchError(
      'configuration',
      'A note id is only usable for a note this session listed. Search for it first, or pass the note share link.',
    );
  }
  return { id: raw, handle };
}

/**
 * Read a note, and its first comment page in the same transaction when it was asked for. Splitting
 * them into two reads would repeat the page load and the identity probe, and would leave the
 * comments the page had already loaded with nowhere to be reused.
 */
export async function readXhsNote(
  input: { url?: string; id?: string; handle?: TabHandle; withComments?: boolean; commentLimit?: number },
  ctx: XhsContext,
): Promise<XhsNoteRead> {
  guard(ctx);
  const target = resolveTarget(input);
  const limit = Math.min(Math.max(input.commentLimit ?? 20, 1), 50);
  const withComments = input.withComments === true;

  const run = async (): Promise<XhsNoteRead> => browserFor(ctx).readTab(async tab => {
    const probe = await tab.evaluate<StateProbe>(stateProbeScript());
    requireSignedIn(probe);

    const detail = tab.expectResponse(url => url.pathname === '/api/sns/web/v1/feed', ctx.timeoutMs);
    detail.catch(() => undefined);

    if (input.url && input.url.includes('/')) {
      // A share link is a defined way in: open the target itself, carrying the token it holds.
      await tab.navigate(input.url, ctx.timeoutMs);
    } else {
      // Otherwise click the card that was listed, so the page arrives the way a person's would.
      // Re-check right before acting: geometry seen during the search is stale by definition.
      const check = await tab.evaluate<{ found: boolean; clickable: boolean }>(candidateCheckScript(target.id, `/explore/${target.id}`));
      if (!check.found) {
        throw new SearchError('protocol', 'The candidate this read referred to is no longer on the page. Search again to get a fresh reference.');
      }
      if (!check.clickable) {
        throw new SearchError('protocol', 'The candidate this read referred to is covered or hidden right now, so it was not clicked. Search again or open the note by its share link.');
      }
      await tab.clickTarget(candidateSelector(target.id), ctx.timeoutMs);
    }

    const data = await readEnvelope(await detail, 'note');
    const items = data.items;
    if (items !== undefined && !Array.isArray(items)) {
      throw new SearchError('protocol', 'The Xiaohongshu note response carried an unexpected item list.');
    }
    // An empty item list is the site saying this note is not readable by this account, which is a
    // subject refusal. Waiting for a state that will never arrive would report it as a timeout.
    if (Array.isArray(items) && items.length === 0) {
      throw new SearchError(
        'authentication',
        'Xiaohongshu returned no note for this link. It may be private, deleted, or not visible to this account.',
      );
    }

    const note = await until(async () => {
      const found = await tab.evaluate<NoteDetailProbe>(noteDetailScript(target.id));
      if (!found.found) return undefined;
      if (!found.idMatches) throw new SearchError('protocol', 'The page opened a different note than the one this read asked for.');
      return found;
    }, ctx.timeoutMs, ctx.signal);

    const projectNote: XhsNote = {
      id: target.id,
      title: note.title,
      desc: note.desc,
      author: note.author,
      likes: note.likes,
      collects: note.collects,
      comments: note.comments,
      shares: note.shares,
      ...(note.publishedAt ? { publishedAt: note.publishedAt } : {}),
      tags: note.tags,
      imageUrls: note.imageUrls,
      url: `${DEFAULT_SITE_URL}/explore/${target.id}`,
    };

    if (!withComments) return { note: projectNote };

    // The detail page loads its own first comment page, so this waits for it rather than asking again.
    const first = await until(async () => {
      const state = await tab.evaluate<CommentsProbe>(commentsStateScript(target.id));
      if (state.comments.length > 0 || state.loaded) return state;
      return undefined;
    }, ctx.timeoutMs, ctx.signal);

    const collected: XhsComment[] = [...first.comments];
    const seen = new Set(collected.map(comment => comment.id));
    let cursor = first.cursor;
    let hasMore = first.hasMore;

    // Only one follow-up page is taken, and only when the tool asked for more comments than arrived.
    if (hasMore && collected.length < limit) {
      const nextResponse = tab.expectResponse(url => url.pathname === '/api/sns/web/v2/comment/page' && url.searchParams.get('note_id') === target.id && (url.searchParams.get('cursor') ?? '') !== '', ctx.timeoutMs);
      nextResponse.catch(() => undefined);
      await tab.scrollBy('.note-scroller', 1600, ctx.timeoutMs);
      const next = await readEnvelope(await nextResponse, 'comment page');
      const list = next.comments;
      if (!Array.isArray(list)) throw new SearchError('protocol', 'The Xiaohongshu comment response carried no comment list.');
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        if (item.invalid) continue;
        const id = stringOf(item.id);
        if (id === '' || seen.has(id)) continue;
        seen.add(id);
        const user = (item.user_info ?? {}) as Record<string, unknown>;
        collected.push({
          id,
          author: stringOf(user.nickname) || stringOf(user.nick_name),
          content: stringOf(item.content),
          likes: item.like_count === undefined || item.like_count === null ? '0' : String(item.like_count),
          replies: item.sub_comment_count === undefined || item.sub_comment_count === null ? '0' : String(item.sub_comment_count),
          ipLocation: stringOf(item.ip_location),
        });
      }
      hasMore = next.has_more === true;
      cursor = stringOf(next.cursor);
    }

    const comments = collected.slice(0, limit);
    return {
      note: projectNote,
      comments: { comments, hasMore: hasMore || collected.length > limit, ...(cursor ? { cursor } : {}) },
    };
  }, { ...(target.handle ? { handle: target.handle } : {}), signal: ctx.signal });

  try {
    return await run();
  } catch (error) {
    // A dead handle is worth forgetting: keeping it would make every later attempt on that tab
    // fail the same way instead of telling the caller to search again.
    if (target.handle && isStaleHandle(error)) forgetListedFrom(target.handle);
    throw error;
  }
}

/** A note's detail, without its comments. */
export async function fetchXhsNote(input: { url?: string; id?: string; handle?: TabHandle }, ctx: XhsContext): Promise<XhsNote> {
  return (await readXhsNote({ ...input }, ctx)).note;
}

/** One comment page for a note, read as part of the same kind of transaction as the note itself. */
export async function fetchXhsComments(input: { url?: string; id?: string; handle?: TabHandle; limit?: number }, ctx: XhsContext): Promise<XhsCommentPage> {
  const read = await readXhsNote({ ...input, withComments: true }, ctx);
  return read.comments ?? { comments: [], hasMore: false };
}
