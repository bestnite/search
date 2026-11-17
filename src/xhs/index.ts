import { homedir } from 'node:os';
import { join } from 'node:path';
import { SearchError } from '../transport.js';
import type { Source } from '../types.js';
import { BrowserSession, sessionFor, type BrowserSessionOptions } from '../browser.js';
import { commentsScript, healthScript, noteScript, searchScript } from './scripts.js';

/**
 * Xiaohongshu reads through the user's own browser. Everything here is a read: search, one note,
 * its comments. Nothing writes, nothing marks anything read, and every call is capped.
 */
export interface XhsContext {
  wsEndpoint: string;
  token?: string;
  siteUrl?: string;
  /** File holding the signed-in session, so a fresh process starts already logged in. */
  statePath?: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Injected in tests; production uses the real browser connection. */
  browser?: Pick<BrowserSession, 'evaluate' | 'target' | 'persist' | 'close'>;
}

/**
 * Default session file, kept beside the browser container's volume so the session the container
 * saves is the session a read starts from. Override with the statePath option or XHS_STATE_PATH.
 */
export const DEFAULT_STATE_PATH = join(homedir(), '.config', 'dsh-search', 'browser', 'state.json');

export const DEFAULT_SITE_URL = 'https://www.xiaohongshu.com/explore';

export interface XhsNoteSummary {
  id: string;
  title: string;
  author: string;
  likes: string;
  url: string;
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
  /** Picture URLs, in the order the note shows them. */
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

interface PageAnswer { ok?: boolean; code?: string; message?: string; status?: number }

/**
 * One connection per endpoint, kept for the life of the process.
 *
 * A connection owns its browser context, and that context is the window a human signs into over
 * VNC. Dropping it after every read would close that window and leave no way to log in, so the
 * connection is reused until the host shuts it down.
 */
/**
 * Search results carry the per-note token that detail and comment reads require, but a Source must
 * not expose it. Keeping it here is what lets a caller read a note it just saw in a search.
 */
const noteTokens = new Map<string, string>();
const TOKEN_CACHE_LIMIT = 500;

function rememberToken(id: string, token: string | undefined): void {
  if (!token) return;
  noteTokens.set(id, token);
  if (noteTokens.size > TOKEN_CACHE_LIMIT) {
    const oldest = noteTokens.keys().next();
    if (!oldest.done) noteTokens.delete(oldest.value);
  }
}

const browserFor = (ctx: XhsContext): Pick<BrowserSession, 'evaluate' | 'target' | 'persist' | 'close'> =>
  ctx.browser ?? sessionFor(`xhs|${ctx.wsEndpoint}|${ctx.token ?? ''}`, optionsOf(ctx));

export function optionsOf(ctx: XhsContext): BrowserSessionOptions {
  return {
    wsEndpoint: ctx.wsEndpoint,
    siteUrl: ctx.siteUrl ?? DEFAULT_SITE_URL,
    timeoutMs: ctx.timeoutMs,
    statePath: ctx.statePath ?? process.env.XHS_STATE_PATH ?? DEFAULT_STATE_PATH,
    ...(ctx.token ? { token: ctx.token } : {}),
  };
}

/** Page answers carry their own vocabulary; translate once, here. */
export function unwrapAnswer<T>(answer: unknown): T {
  const body = (answer ?? {}) as PageAnswer;
  if (body.ok === true) return answer as T;
  const code = body.code ?? '';
  const detail = body.message ?? 'no detail';
  if (code === 'NOT_READY' || code === 'NO_RUNTIME' || code === 'NO_CLIENT' || code === 'NO_REGISTRATION' || code === 'BAD_CLIENT') {
    return fail('protocol', `The browser page has not loaded Xiaohongshu, so the site runtime was unavailable (${code}). Open xiaohongshu.com in that browser once.`);
  }
  if (code === 'EMPTY') return fail('protocol', `Xiaohongshu returned no note for that id (${detail}).`);
  const status = Number(body.status ?? 0);
  if (/登录|login/i.test(detail)) {
    return fail('authentication', `Xiaohongshu says the browser is not signed in (${detail}). Open the browser container's VNC page, sign in once in the window that is already open, and ask again.`);
  }
  if (status === 401 || status === 406) return fail('authentication', `Xiaohongshu refused the read with HTTP ${status}; the browser session is not signed in or was challenged. Sign in again in that browser.`);
  if (status === 403) return fail('authentication', `Xiaohongshu denied this read with HTTP 403 (${detail}). The subject may be private, or the session lacks permission.`);
  if (status === 429) return fail('rate-limit', 'Xiaohongshu rate-limited the read; wait before asking again.');
  return fail('protocol', `Xiaohongshu answered something unexpected (${code || 'no code'}): ${detail}`);
}

function fail(kind: 'protocol' | 'authentication' | 'rate-limit', message: string): never {
  throw new SearchError(kind, message);
}

const guard = (ctx: XhsContext): void => {
  if (!ctx.wsEndpoint) throw new SearchError('configuration', 'The Xiaohongshu backend needs a Playwright endpoint. Set the browser endpoint option or XHS_WS_ENDPOINT to the URL the browser prints at startup.');
  if (ctx.signal.aborted) throw new SearchError('cancelled', 'The Xiaohongshu read was cancelled.');
};

/** Read the search page, which also yields the per-note token that detail and comment reads need. */
export async function readXhsSearchNotes(input: { query: string; limit: number; sort?: string }, ctx: XhsContext): Promise<XhsNoteSummary[]> {
  guard(ctx);
  const browser = browserFor(ctx);
  try {
    await unwrapAnswer(await browser.evaluate(healthScript()));
    const answer = unwrapAnswer<{ items: XhsNoteSummary[] }>(
      await browser.evaluate(searchScript({ query: input.query, limit: input.limit, page: 1, sort: input.sort ?? 'general' })),
    );
    for (const item of answer.items) rememberToken(item.id, (item as { xsecToken?: string }).xsecToken);
    return answer.items;
  } finally {
    await browser.persist().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

/** Search as the engine sees it: citeable sources, one per note. */
export async function searchXhs(input: { query: string; maxResults: number; sort?: string }, ctx: XhsContext): Promise<Source[]> {
  const notes = await readXhsSearchNotes({ query: input.query, limit: Math.min(Math.max(input.maxResults, 1), 40), ...(input.sort ? { sort: input.sort } : {}) }, ctx);
  return notes.map(note => ({
    url: note.url,
    title: note.title === '' ? `小红书 note by ${note.author}` : note.title,
    summary: `${note.author} · ${note.likes} likes`,
  }));
}

/** A note's detail. The token comes from the argument, the share link, or an earlier search. */
export async function fetchXhsNote(input: { url?: string; id?: string; token?: string }, ctx: XhsContext): Promise<XhsNote> {
  guard(ctx);
  const { id, token } = resolveTarget({ ...input, token: input.token ?? noteTokens.get(trimNoteId(input)) });
  const browser = browserFor(ctx);
  try {
    await unwrapAnswer(await browser.evaluate(healthScript()));
    const answer = unwrapAnswer<{ note: XhsNote }>(await browser.evaluate(noteScript({ id, token })));
    return answer.note;
  } finally {
    await browser.persist().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

export async function fetchXhsComments(input: { url?: string; id?: string; token?: string; limit?: number; cursor?: string }, ctx: XhsContext): Promise<{ comments: XhsComment[]; hasMore: boolean; cursor?: string }> {
  guard(ctx);
  const { id, token } = resolveTarget({ ...input, token: input.token ?? noteTokens.get(trimNoteId(input)) });
  const browser = browserFor(ctx);
  try {
    await unwrapAnswer(await browser.evaluate(healthScript()));
    return unwrapAnswer<{ comments: XhsComment[]; hasMore: boolean; cursor?: string }>(
      await browser.evaluate(commentsScript({ id, token, cursor: input.cursor ?? '', limit: Math.min(Math.max(input.limit ?? 20, 1), 100) })),
    );
  } finally {
    await browser.persist().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

/** Best-effort id from whatever the caller passed, used only to look up a remembered token. */
function trimNoteId(input: { url?: string; id?: string }): string {
  const raw = (input.url ?? input.id ?? '').trim();
  const match = /\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/.exec(raw);
  return match?.[1] ?? raw;
}

/** Accept a share link, a bare id, or an explicit token. Share links embed xsec_token. */
export function resolveTarget(input: { url?: string; id?: string; token?: string }): { id: string; token: string } {
  const raw = (input.url ?? input.id ?? '').trim();
  if (raw === '') throw new SearchError('configuration', 'Pass a note URL or a note id.');
  let id = raw;
  let token = input.token ?? '';
  if (raw.includes('/')) {
    try {
      const url = new URL(raw);
      const match = /\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/.exec(url.pathname);
      id = match?.[1] ?? url.pathname.split('/').filter(Boolean).pop() ?? '';
      token = token || url.searchParams.get('xsec_token') || url.searchParams.get('xsecToken') || '';
    } catch {
      throw new SearchError('configuration', `"${raw}" is not a Xiaohongshu note URL.`);
    }
  }
  if (id === '') throw new SearchError('configuration', `Could not read a note id from "${raw}".`);
  if (token === '') throw new SearchError('configuration', 'A note read needs its xsec_token. Search for the note first, use its share link, or pass the token explicitly.');
  return { id, token };
}
