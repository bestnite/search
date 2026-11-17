import { SearchError } from '../transport.js';
import type { Source } from '../types.js';
import { XhsBrowser, type BrowserOptions } from './browser.js';
import { commentsScript, healthScript, noteScript, searchScript } from './scripts.js';

/**
 * Xiaohongshu reads through the user's own browser. Everything here is a read: search, one note,
 * its comments. Nothing writes, nothing marks anything read, and every call is capped.
 */
export interface XhsContext {
  wsEndpoint: string;
  token?: string;
  siteUrl?: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Injected in tests; production uses the real browser connection. */
  browser?: Pick<XhsBrowser, 'evaluate' | 'target' | 'close'>;
}

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
  images: number;
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

const browserFor = (ctx: XhsContext): Pick<XhsBrowser, 'evaluate' | 'target' | 'close'> =>
  ctx.browser ?? new XhsBrowser(optionsOf(ctx));

export function optionsOf(ctx: XhsContext): BrowserOptions {
  return {
    wsEndpoint: ctx.wsEndpoint,
    siteUrl: ctx.siteUrl ?? DEFAULT_SITE_URL,
    timeoutMs: ctx.timeoutMs,
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
    return answer.items;
  } finally {
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

/** A note's detail. Share links carry the token in the query string, which is where it comes from. */
export async function fetchXhsNote(input: { url?: string; id?: string; token?: string }, ctx: XhsContext): Promise<XhsNote> {
  guard(ctx);
  const { id, token } = resolveTarget(input);
  const browser = browserFor(ctx);
  try {
    await unwrapAnswer(await browser.evaluate(healthScript()));
    const answer = unwrapAnswer<{ note: XhsNote }>(await browser.evaluate(noteScript({ id, token })));
    return answer.note;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function fetchXhsComments(input: { url?: string; id?: string; token?: string; limit?: number; cursor?: string }, ctx: XhsContext): Promise<{ comments: XhsComment[]; hasMore: boolean; cursor?: string }> {
  guard(ctx);
  const { id, token } = resolveTarget(input);
  const browser = browserFor(ctx);
  try {
    await unwrapAnswer(await browser.evaluate(healthScript()));
    return unwrapAnswer<{ comments: XhsComment[]; hasMore: boolean; cursor?: string }>(
      await browser.evaluate(commentsScript({ id, token, cursor: input.cursor ?? '', limit: Math.min(Math.max(input.limit ?? 20, 1), 100) })),
    );
  } finally {
    await browser.close().catch(() => undefined);
  }
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
  if (token === '') throw new SearchError('configuration', 'A note read needs its xsec_token. Use the share link, which carries it, or pass the token explicitly.');
  return { id, token };
}
