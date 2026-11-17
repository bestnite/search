// Minimal read-only Reddit access for the DSH search plugin: search posts and read a thread.
//
// Two strictly separate paths; neither ever falls back to the other:
//   anonymous - application-only token from the loid endpoint, then the gql-fed.reddit.com
//               persisted operations (search and comments). Post metadata for a thread comes from
//               oauth.reddit.com/by_id, which is the one REST endpoint the anonymous token still
//               answers (REST /comments and /search return a 403 interception page).
//   oauth     - access token from www.reddit.com/api/v1/access_token, then plain oauth.reddit.com
//               REST (/search and /comments).
//
// Every failure is a SearchError with one of the plugin's kinds: configuration, authentication,
// rate-limit, protocol, network, timeout or quota. Messages never carry a token, a client secret, a
// password, or a raw upstream body. Ported from bestnite/reddit-readonly-mcp with the RSS fallback,
// trending, user/profile, cache, logger and CLI deliberately left behind.

import { SearchError } from '../transport.js';
import type { Source } from '../types.js';
import {
  RedditAuth,
  mapThrown,
  requestSignal,
  requireCredentials,
  retryAfterMs,
  statusError,
  type RedditCredentials,
  type RedditMode,
} from './auth.js';
import {
  COMMENT_SORTS,
  MAX_COMMENTS_PER_REQUEST,
  MAX_COMMENT_DEPTH,
  MAX_SEARCH_RESULTS,
  RedditGqlClient,
  SEARCH_SORTS,
  SEARCH_TIME_RANGES,
  type CommentSort,
  type SearchSort,
  type SearchTime,
} from './gql.js';
import {
  buildCommentTree,
  gqlPost,
  normalizeThreadId,
  permalinkUrl,
  restCommentTree,
  restPost,
  restSearchPosts,
  restThreadPost,
  toSource,
  trimBodies,
  type PostData,
  type RedditComment,
} from './shape.js';

export type { RedditCredentials } from './auth.js';
export type { RedditComment } from './shape.js';
export { resetRedditTokenCache } from './auth.js';

export interface RedditContext {
  mode: 'oauth' | 'anonymous';
  credentials: RedditCredentials;
  signal: AbortSignal;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export interface RedditThread {
  post: {
    id: string;
    title: string;
    url: string;
    author: string;
    score: number;
    createdUtc?: number;
    selfText?: string;
  };
  comments: RedditComment[];
  truncated: boolean;
}

export interface SearchRedditInput {
  query: string;
  maxResults: number;
  sort?: string;
  time?: string;
  subreddit?: string;
}

export interface FetchRedditThreadInput {
  id: string;
  sort?: string;
  limit: number;
  depth: number;
  maxChars: number;
}

const OAUTH_SEARCH_URL = 'https://oauth.reddit.com/search';
const OAUTH_COMMENTS_URL = 'https://oauth.reddit.com/comments';
const BY_ID_URL = 'https://oauth.reddit.com/by_id';

export async function searchReddit(input: SearchRedditInput, ctx: RedditContext): Promise<Source[]> {
  const mode = resolveMode(ctx);
  const query = input.query?.trim() ?? '';
  if (query === '') throw new SearchError('configuration', 'Reddit search needs a non-empty query.');
  const maxResults = positiveInt(input.maxResults, 'maxResults', MAX_SEARCH_RESULTS);
  const sort = searchSort(input.sort);
  const time = searchTime(input.time);
  const subreddit = normalizeSubreddit(input.subreddit);

  requireCredentials(mode, ctx.credentials);
  const session = openSession(mode, ctx);
  const posts =
    mode === 'oauth'
      ? await searchPostsRest(session, { query, maxResults, sort, time, subreddit })
      : await searchPostsGql(session, { query, maxResults, sort, time, subreddit });

  return posts.slice(0, maxResults).map(toSource);
}

export async function fetchRedditThread(
  input: FetchRedditThreadInput,
  ctx: RedditContext,
): Promise<RedditThread> {
  const mode = resolveMode(ctx);
  const id = normalizeThreadId(input.id ?? '');
  const sort = commentSort(input.sort);
  const limit = positiveInt(input.limit, 'limit', MAX_COMMENTS_PER_REQUEST);
  const depth = positiveInt(input.depth, 'depth', MAX_COMMENT_DEPTH);
  const maxChars = positiveInt(input.maxChars, 'maxChars', Number.MAX_SAFE_INTEGER);

  requireCredentials(mode, ctx.credentials);
  const session = openSession(mode, ctx);
  const thread =
    mode === 'oauth'
      ? await threadRest(session, { id, sort, limit, depth })
      : await threadGql(session, { id, sort, limit, depth });
  const truncated = trimBodies(thread.comments, maxChars);
  return { ...thread, truncated };
}

// ---------------------------------------------------------------------------
// Session plumbing
// ---------------------------------------------------------------------------

interface Session {
  mode: RedditMode;
  auth: RedditAuth;
  fetch: typeof fetch;
  signal: AbortSignal;
  timeoutMs: number;
}

function openSession(mode: RedditMode, ctx: RedditContext): Session {
  const fetchImpl = ctx.fetch ?? ((...args) => fetch(...args));
  if (!Number.isFinite(ctx.timeoutMs) || ctx.timeoutMs <= 0) {
    throw new SearchError('configuration', 'Reddit access needs a positive timeout.');
  }
  const auth = new RedditAuth({
    mode,
    credentials: ctx.credentials,
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
    fetch: fetchImpl,
  });
  return { mode, auth, fetch: fetchImpl, signal: ctx.signal, timeoutMs: ctx.timeoutMs };
}

function resolveMode(ctx: RedditContext): RedditMode {
  if (ctx.mode !== 'oauth' && ctx.mode !== 'anonymous') {
    throw new SearchError('configuration', 'Reddit access mode must be "oauth" or "anonymous".');
  }
  return ctx.mode;
}

// ---------------------------------------------------------------------------
// anonymous path
// ---------------------------------------------------------------------------

async function searchPostsGql(
  session: Session,
  input: { query: string; maxResults: number; sort: SearchSort; time: SearchTime; subreddit?: string },
): Promise<PostData[]> {
  const client = gqlClient(session);
  const nodes = await client.search({
    query: input.query,
    ...(input.subreddit === undefined ? {} : { subreddit: input.subreddit }),
    sort: input.sort,
    time: input.time,
    maxResults: input.maxResults,
  });
  return nodes.map(gqlPost);
}

async function threadGql(
  session: Session,
  input: { id: string; sort: CommentSort; limit: number; depth: number },
): Promise<RedditThread> {
  const client = gqlClient(session);
  const trees = await client.comments({
    postId: input.id,
    sort: input.sort,
    limit: input.limit,
    depth: input.depth,
  });
  const comments = buildCommentTree(trees, input.depth, input.limit);
  const post = await postById(session, input.id);
  return { post: toThreadPost(post), comments, truncated: false };
}

function gqlClient(session: Session): RedditGqlClient {
  return new RedditGqlClient({
    auth: session.auth,
    signal: session.signal,
    timeoutMs: session.timeoutMs,
    fetch: session.fetch,
  });
}

/** oauth.reddit.com/by_id still answers the anonymous token, unlike /comments and /search. */
async function postById(session: Session, id: string): Promise<PostData> {
  const payload = await readOauthJson(session, `${BY_ID_URL}/t3_${id}`, { raw_json: 1 }, `post ${id}`);
  const children = (payload as { data?: { children?: unknown } } | null)?.data?.children;
  const thing = Array.isArray(children) ? (children[0] as { kind?: string; data?: Record<string, unknown> } | undefined) : undefined;
  if (!thing || thing.kind !== 't3' || !thing.data) {
    throw new SearchError('protocol', `Reddit returned no post for thread ${id}.`);
  }
  return restPost(thing.data);
}

// ---------------------------------------------------------------------------
// oauth path
// ---------------------------------------------------------------------------

async function searchPostsRest(
  session: Session,
  input: { query: string; maxResults: number; sort: SearchSort; time: SearchTime; subreddit?: string },
): Promise<PostData[]> {
  const payload = await readOauthJson(
    session,
    OAUTH_SEARCH_URL,
    {
      q: input.subreddit ? `${input.query} subreddit:${input.subreddit}` : input.query,
      sort: input.sort,
      t: input.time,
      limit: input.maxResults,
      raw_json: 1,
    },
    'the Reddit search',
  );
  return restSearchPosts(payload);
}

async function threadRest(
  session: Session,
  input: { id: string; sort: CommentSort; limit: number; depth: number },
): Promise<RedditThread> {
  const payload = await readOauthJson(
    session,
    `${OAUTH_COMMENTS_URL}/${input.id}`,
    { sort: input.sort, limit: input.limit, depth: input.depth, raw_json: 1 },
    `the comments of ${input.id}`,
  );
  const post = restPost(restThreadPost(payload));
  const comments = restCommentTree(payload, input.depth, input.limit);
  return { post: toThreadPost(post), comments, truncated: false };
}

/** One REST read with the narrow retry policy: one 401 refresh, one 429 rotation plus back-off. */
async function readOauthJson(
  session: Session,
  url: string,
  params: Record<string, string | number>,
  what: string,
): Promise<unknown> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value));

  let access = await session.auth.access();
  let response = await sendRest(session, target, access.headers, what);

  if (response.status === 401) {
    await session.auth.refresh();
    access = await session.auth.access();
    response = await sendRest(session, target, access.headers, what);
  }

  if (response.status === 429) {
    await session.auth.rotate();
    access = await session.auth.access();
    const documented = retryAfterMs(response.headers);
    if (documented > 0) await sleep(documented);
    response = await sendRest(session, target, access.headers, what);
    if (response.status === 429) {
      throw new SearchError('rate-limit', `Reddit rate-limited the request for ${what}; retry later.`, 429);
    }
  }

  if (response.status < 200 || response.status >= 300) {
    throw statusError(response.status, what, session.mode);
  }
  try {
    return JSON.parse(response.text);
  } catch {
    throw new SearchError('protocol', `Reddit answered the request for ${what} with something that is not JSON.`);
  }
}

async function sendRest(
  session: Session,
  url: URL,
  headers: Record<string, string>,
  what: string,
): Promise<{ status: number; headers: Headers; text: string }> {
  let response: Response;
  try {
    response = await session.fetch(url.toString(), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: requestSignal(session.signal, session.timeoutMs),
    });
  } catch (error) {
    throw mapThrown(error, session.signal, session.timeoutMs, what);
  }
  const text = await response.text().catch(() => '');
  return { status: response.status, headers: response.headers, text };
}

// ---------------------------------------------------------------------------
// Mapping and validation
// ---------------------------------------------------------------------------

function toThreadPost(post: PostData): RedditThread['post'] {
  const threadPost: RedditThread['post'] = {
    id: post.id,
    title: post.title,
    url: post.permalink !== '' ? permalinkUrl(post.permalink, post.id) : post.url || permalinkUrl('', post.id),
    author: post.author,
    score: post.score,
  };
  if (post.createdUtc !== undefined) threadPost.createdUtc = post.createdUtc;
  if (post.selfText !== undefined && post.selfText !== '') threadPost.selfText = post.selfText;
  return threadPost;
}

function positiveInt(value: number, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new SearchError('configuration', `Reddit ${name} must be a positive integer.`);
  }
  return Math.min(Math.trunc(value), max);
}

function searchSort(raw: string | undefined): SearchSort {
  if (raw === undefined || raw.trim() === '') return 'relevance';
  const key = raw.trim().toLowerCase();
  if (!Object.hasOwn(SEARCH_SORTS, key)) {
    throw new SearchError(
      'configuration',
      `Reddit search sort must be one of ${Object.keys(SEARCH_SORTS).join(', ')}.`,
    );
  }
  return key as SearchSort;
}

function searchTime(raw: string | undefined): SearchTime {
  if (raw === undefined || raw.trim() === '') return 'all';
  const key = raw.trim().toLowerCase();
  if (!Object.hasOwn(SEARCH_TIME_RANGES, key)) {
    throw new SearchError(
      'configuration',
      `Reddit search time window must be one of ${Object.keys(SEARCH_TIME_RANGES).join(', ')}.`,
    );
  }
  return key as SearchTime;
}

function commentSort(raw: string | undefined): CommentSort {
  if (raw === undefined || raw.trim() === '') return 'confidence';
  const key = raw.trim().toLowerCase();
  if (!Object.hasOwn(COMMENT_SORTS, key)) {
    throw new SearchError(
      'configuration',
      `Reddit comment sort must be one of ${Object.keys(COMMENT_SORTS).join(', ')}.`,
    );
  }
  return key as CommentSort;
}

/** Strip a leading r/ so the same value works for both paths. */
function normalizeSubreddit(raw: string | undefined): string | undefined {
  const value = raw?.trim().replace(/^\/?r\//i, '');
  if (value === undefined || value === '') return undefined;
  if (!/^[A-Za-z0-9_]{2,21}$/.test(value)) {
    throw new SearchError('configuration', 'A subreddit name may only contain letters, digits and underscores.');
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
