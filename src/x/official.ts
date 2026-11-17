import type { Source } from '../types.js';
import { SearchError } from '../transport.js';
import { withAppUserAgent } from '../ua.js';

/**
 * Official X API v2 recent search.
 *
 * Billing is per post read, so the request is sized deliberately: the endpoint
 * rejects `max_results` below 10, and a larger request costs more than a smaller
 * one. The caller's result limit therefore becomes a ceiling that is never
 * exceeded, rounded up to the API minimum when it asks for fewer posts.
 */
export const OFFICIAL_SEARCH_URL = 'https://api.x.com/2/tweets/search/recent';
export const API_MIN_RESULTS = 10;
export const API_MAX_RESULTS = 100;

export interface OfficialContext { bearerToken: string; signal: AbortSignal; timeoutMs: number; /** Cap on posts read per search; billing is per post. */ postsPerSearch?: number; fetch?: typeof fetch }

type Row = Record<string, unknown>;
const row = (value: unknown): Row => (value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {});

export async function searchXOfficial(input: { query: string; maxResults: number }, ctx: OfficialContext): Promise<Source[]> {
  const ceiling = Math.min(input.maxResults, ctx.postsPerSearch && ctx.postsPerSearch > 0 ? ctx.postsPerSearch : API_MAX_RESULTS);
  const requested = Math.min(API_MAX_RESULTS, Math.max(API_MIN_RESULTS, ceiling));
  const url = new URL(OFFICIAL_SEARCH_URL);
  url.searchParams.set('query', input.query);
  url.searchParams.set('max_results', String(requested));
  url.searchParams.set('tweet.fields', 'created_at,public_metrics,author_id');
  url.searchParams.set('expansions', 'author_id');
  url.searchParams.set('user.fields', 'username');
  const fetcher = ctx.fetch ?? fetch;
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]);
  let response: Response;
  try {
    response = await fetcher(url, { headers: withAppUserAgent({ Authorization: `Bearer ${ctx.bearerToken}`, Accept: 'application/json' }), signal });
  } catch (error) {
    if (ctx.signal.aborted) throw new SearchError('timeout', 'The request was cancelled or timed out.');
    throw new SearchError('network', 'Could not reach the X API; check connectivity and the endpoint.');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new SearchError('authentication', 'The X bearer token was rejected. Ask the user to rotate it in the X developer console.', response.status);
    if (response.status === 429) throw new SearchError('rate-limit', 'X rate limit reached; wait before asking again.', response.status);
    if (response.status === 400) throw new SearchError('configuration', 'X rejected the query. Check operators and length (maximum 512 characters).', response.status);
    throw new SearchError('http', `X returned HTTP ${response.status}.`, response.status);
  }
  let body: Row;
  try { body = row(JSON.parse(await response.text())); } catch { throw new SearchError('protocol', 'X returned a body that is not JSON.'); }
  const users = new Map<string, string>();
  for (const user of Array.isArray(row(body.includes).users) ? row(body.includes).users as unknown[] : []) {
    const u = row(user);
    if (typeof u.id === 'string' && typeof u.username === 'string') users.set(u.id, u.username);
  }
  const posts = Array.isArray(body.data) ? body.data as unknown[] : [];
  if (!posts.length && body.meta === undefined) throw new SearchError('protocol', 'X returned no data and no metadata.');
  const mapped = posts.flatMap(value => {
    const post = row(value);
    if (typeof post.id !== 'string') return [];
    const username = users.get(String(post.author_id));
    const text = typeof post.text === 'string' ? post.text.replace(/\s+/g, ' ').trim() : '';
    const metrics = row(post.public_metrics);
    return [{
      url: username ? `https://x.com/${username}/status/${post.id}` : `https://x.com/i/web/status/${post.id}`,
      title: `${username ? `@${username}` : 'X post'}: ${text.slice(0, 90)}`,
      snippet: text,
      summary: typeof metrics.like_count === 'number' ? `${String(metrics.like_count)} likes, ${String(metrics.repost_count ?? 0)} reposts` : undefined,
      publishedAt: typeof post.created_at === 'string' ? post.created_at : undefined,
    } satisfies Source];
  });
  // Billing is per post read, so never hand the caller more than the configured cap.
  return mapped.slice(0, ceiling);
}
