import type { Source } from '../types.js';
import { SearchError } from '../transport.js';
import {
  DEFAULT_LANG,
  GRAPHQL_BASE,
  SEARCH_PAGE,
  MAINTAINER_ACTION,
  type SessionCredential,
  apiHeaders,
  authFailure,
  mapThrown,
  requireCredentials,
  requestSignal,
} from './auth.js';
import { OPERATION_NAME, SearchOperationCache, type DiscoveryTransport } from './discovery.js';
import { parseInstructions, toSource } from './parse.js';

export type { SessionCredential };

export interface SessionContext {
  credentials: SessionCredential;
  signal: AbortSignal;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export const SEARCH_PAGE_SIZE = 20;
/** Web search asks for at most this many posts in one request; X caps a page at 40. */
export const MAX_POSTS_PER_REQUEST = 40;

const operations = new SearchOperationCache();

/** Test seam: forget the cached query id so the next call rediscovers it. */
export function resetXSessionState(): void {
  operations.reset();
}

/**
 * Search posts through the same operation the web app uses.
 *
 * Two requests: the search page (which carries the current query id and its variable
 * template), then the GraphQL read. The query id changes with a deploy, so a 404 on the
 * read triggers one rediscovery and one retry, and nothing else is retried.
 */
export async function searchXSession(input: { query: string; maxResults: number }, ctx: SessionContext): Promise<Source[]> {
  requireCredentials(ctx.credentials);
  const transport: DiscoveryTransport = {
    credentials: { ...ctx.credentials, lang: ctx.credentials.lang ?? DEFAULT_LANG },
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
    ...(ctx.fetch ? { fetchImpl: ctx.fetch } : {}),
  };
  const limit = Math.min(input.maxResults, MAX_POSTS_PER_REQUEST);
  const target = { pageUrl: `${SEARCH_PAGE}?q=${encodeURIComponent(input.query)}&src=typed_query&f=live`, operationName: OPERATION_NAME };
  let operation = await operations.get(transport, target);
  let body = await read(transport, operation, input.query, limit, ctx);
  if (body === 'stale') {
    operation = await operations.get(transport, target, true);
    body = await read(transport, operation, input.query, limit, ctx);
    if (body === 'stale') {
      throw new SearchError('protocol', `X rejected the ${OPERATION_NAME} query id twice in a row after rediscovery. ${MAINTAINER_ACTION}`);
    }
  }
  return parseInstructions(body, limit).map(toSource);
}

async function read(
  transport: DiscoveryTransport,
  operation: { queryId: string; variables: Record<string, unknown> },
  query: string,
  limit: number,
  ctx: SessionContext,
): Promise<Record<string, unknown> | 'stale'> {
  // Keep the site's own variable template: it carries the relay feature switches this
  // operation requires, and dropping them answers 422 GRAPHQL_VALIDATION_FAILED.
  const variables = {
    ...operation.variables,
    rawQuery: query,
    count: limit,
    cursor: null,
    product: 'Latest',
    querySource: 'typed_query',
  };
  const url = `${GRAPHQL_BASE}/${operation.queryId}/${OPERATION_NAME}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
  const fetcher = ctx.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: apiHeaders(transport.credentials),
      redirect: 'follow',
      signal: requestSignal(ctx.signal, ctx.timeoutMs),
    });
  } catch (error) {
    throw mapThrown(error, ctx.signal, ctx.timeoutMs, 'the x.com search API');
  }
  if (response.status === 401 || response.status === 403) throw authFailure(response.status);
  if (response.status === 429) throw new SearchError('rate-limit', 'X rate limit reached; wait before asking again.', 429);
  if (response.status === 404) return 'stale';
  if (!response.ok) throw new SearchError('http', `X returned HTTP ${response.status} for the search API.`, response.status);
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    throw mapThrown(error, ctx.signal, ctx.timeoutMs, 'the x.com search API');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SearchError('protocol', 'X returned a search response that is not JSON.');
  }
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0 && !body.data) {
    // A validation failure means the mined variables no longer match the operation.
    throw new SearchError('protocol', `X rejected the ${OPERATION_NAME} variables (${describeErrors(errors)}). ${MAINTAINER_ACTION}`);
  }
  return body;
}

function describeErrors(errors: unknown[]): string {
  const first = errors[0];
  if (first && typeof first === 'object') {
    const message = (first as { message?: unknown }).message;
    if (typeof message === 'string') return message.slice(0, 160);
  }
  return 'no message';
}
