// gql-fed.reddit.com client for the persisted operations the official Android app sends.
//
// Reddit's REST search/comments endpoints answer anonymous tokens with a 403 interception page, but
// the same token is still accepted by the GraphQL gateway the app talks to. Only the two operations
// this plugin needs are kept: PostComments (comments) and SearchPosts (search).
//
// Retry policy is deliberately narrow: one token refresh on 401, one token rotation plus a bounded
// back-off on 429, and nothing else. The persisted operation names and sha256 hashes are external
// constants copied from bestnite/reddit-readonly-mcp (src/client/gql.ts) - they must not be edited
// into guesses, and a rejected hash is reported as a protocol failure instead of being retried.

import { SearchError } from '../transport.js';
import { RedditAuth, mapThrown, requestSignal, retryAfterMs, statusError } from './auth.js';
import { commentTrees, searchPostNodes, type GqlPostNode, type GqlTree } from './shape.js';

export const GQL_URL = 'https://gql-fed.reddit.com/';

export const OPERATIONS = {
  comments: { name: 'PostComments', hash: '314f29c2494fd78c7844ef2c6b09acb4bef5b37ab50b4ddc01691d6d5c8433f8' },
  searchPosts: { name: 'SearchPosts', hash: '8610e33521c90caa8d12576800c18b708ce0d19df3dfac8e2aad55d9860e4bf9' },
} as const;
export type OperationKey = keyof typeof OPERATIONS;

/** Reddit silently caps a single comment request at 200 top-level comments. */
export const MAX_COMMENTS_PER_REQUEST = 200;
export const MAX_COMMENT_DEPTH = 10;
export const MAX_SEARCH_RESULTS = 100;

export const COMMENT_SORTS = {
  confidence: 'CONFIDENCE',
  best: 'CONFIDENCE',
  top: 'TOP',
  new: 'NEW',
  controversial: 'CONTROVERSIAL',
  old: 'OLD',
  qa: 'QA',
} as const;
export type CommentSort = keyof typeof COMMENT_SORTS;

export const SEARCH_SORTS = {
  relevance: 'RELEVANCE',
  hot: 'HOT',
  top: 'TOP',
  new: 'NEW',
  comments: 'COMMENTS',
} as const;
export type SearchSort = keyof typeof SEARCH_SORTS;

export const SEARCH_TIME_RANGES = {
  hour: 'HOUR',
  day: 'DAY',
  week: 'WEEK',
  month: 'MONTH',
  year: 'YEAR',
  all: 'ALL',
} as const;
export type SearchTime = keyof typeof SEARCH_TIME_RANGES;

export interface GqlClientOptions {
  auth: RedditAuth;
  signal: AbortSignal;
  timeoutMs: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface SearchPostsInput {
  query: string;
  subreddit?: string;
  sort: SearchSort;
  time: SearchTime;
  maxResults: number;
}

export interface PostCommentsInput {
  postId: string;
  sort: CommentSort;
  limit: number;
  depth: number;
}

interface GqlPayload {
  data?: unknown;
  errors?: Array<{ message?: string; extensions?: { code?: string } }> | null;
}

export class RedditGqlClient {
  private readonly auth: RedditAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly signal: AbortSignal;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GqlClientOptions) {
    this.auth = options.auth;
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.signal = options.signal;
    this.timeoutMs = options.timeoutMs;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async search(input: SearchPostsInput): Promise<GqlPostNode[]> {
    const pageSize = Math.min(Math.max(Math.trunc(input.maxResults), 1), MAX_SEARCH_RESULTS);
    const filters: Array<{ key: string; value: string }> = [];
    const variables: Record<string, unknown> = { pageSize, productSurface: '', filters };
    variables.sort = SEARCH_SORTS[input.sort];
    // time_range does nothing for sort=new, and "all" means no restriction at all.
    if (input.time !== 'all' && input.sort !== 'new') {
      filters.push({ key: 'time_range', value: SEARCH_TIME_RANGES[input.time] });
    }
    variables.query = input.subreddit ? `${input.query} subreddit:${input.subreddit}` : input.query;
    const data = await this.query('searchPosts', variables, 'the Reddit search');
    return searchPostNodes(data);
  }

  async comments(input: PostCommentsInput): Promise<GqlTree[]> {
    const count = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_COMMENTS_PER_REQUEST);
    const maxDepth = Math.min(Math.max(Math.trunc(input.depth), 1), MAX_COMMENT_DEPTH);
    const variables: Record<string, unknown> = {
      id: `t3_${input.postId}`,
      sortType: COMMENT_SORTS[input.sort],
      count,
      maxDepth,
      includeConsistencyToken: false,
      includePremiumAvatarTreatment: false,
    };
    const data = await this.query('comments', variables, `the comments of ${input.postId}`);
    return commentTrees(data);
  }

  // -------------------------------------------------------------------------

  private async query(
    op: OperationKey,
    variables: Record<string, unknown>,
    what: string,
  ): Promise<Record<string, unknown>> {
    const operation = OPERATIONS[op];
    const body = JSON.stringify({
      operationName: operation.name,
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: operation.hash } },
    });

    let access = await this.auth.access();
    let response = await this.send(body, access.headers, what);

    // 401: the token went stale, take a new one and retry exactly once.
    if (response.status === 401) {
      await this.auth.refresh();
      access = await this.auth.access();
      response = await this.send(body, access.headers, what);
    }

    // 429: rotate the token (a new one opens a new rate-limit window), wait once, retry once.
    if (response.status === 429) {
      await this.auth.rotate();
      access = await this.auth.access();
      const documented = retryAfterMs(response.headers);
      if (documented > 0) await this.sleep(documented);
      response = await this.send(body, access.headers, what);
      if (response.status === 429) {
        throw new SearchError('rate-limit', `Reddit rate-limited ${what} twice; retry later.`, 429);
      }
    }

    const text = response.text;
    if (response.status < 200 || response.status >= 300) {
      throw statusError(response.status, what, this.auth.mode);
    }

    let payload: GqlPayload;
    try {
      payload = JSON.parse(text) as GqlPayload;
    } catch {
      throw new SearchError('protocol', `Reddit answered ${what} with something that is not JSON.`);
    }

    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    if (errors.length > 0) {
      const codes = errors
        .map((error) => (typeof error?.extensions?.code === 'string' ? error.extensions.code : 'GRAPHQL_ERROR'))
        .join(', ');
      throw new SearchError(
        'protocol',
        `Reddit rejected the ${operation.name} persisted operation (${codes}); the operation hash may have expired.`,
      );
    }

    const data = payload.data;
    if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
      throw new SearchError('protocol', `Reddit returned no data for the ${operation.name} persisted operation.`);
    }
    return data as Record<string, unknown>;
  }

  private async send(
    body: string,
    headers: Record<string, string>,
    what: string,
  ): Promise<{ status: number; headers: Headers; text: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(GQL_URL, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        redirect: 'manual',
        signal: requestSignal(this.signal, this.timeoutMs),
      });
    } catch (error) {
      throw mapThrown(error, this.signal, this.timeoutMs, what);
    }
    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      throw mapThrown(error, this.signal, this.timeoutMs, what);
    }
    return { status: response.status, headers: response.headers, text };
  }
}
