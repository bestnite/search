import { SearchError } from '../transport.js';
import {
  DEFAULT_LANG,
  GRAPHQL_BASE,
  MAINTAINER_ACTION,
  apiHeaders,
  authFailure,
  mapThrown,
  requireCredentials,
  requestSignal,
  type SessionCredential,
} from './auth.js';
import { SearchOperationCache, statusUrl, type DiscoveryTransport } from './discovery.js';
import { parseThread, type XReply, type XThreadPost } from './parse.js';

export interface XThreadContext {
  credentials: SessionCredential;
  signal: AbortSignal;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export interface XThread {
  post: XThreadPost;
  replies: XReply[];
  truncated: boolean;
}

export const THREAD_OPERATION = 'TweetDetail';
export const MAX_REPLIES = 200;

const operations = new SearchOperationCache();

/** Test seam: forget cached query ids so the next call rediscovers them. */
export function resetXThreadState(): void {
  operations.reset();
}

/**
 * Read one post with its replies: the status page carries the TweetDetail operation, the
 * GraphQL read returns the conversation. Same two-request shape as search, so a 404 means a
 * stale query id and gets exactly one rediscovery.
 */
export async function fetchXThread(
  input: { id: string; limit: number; depth: number; maxChars: number },
  ctx: XThreadContext,
): Promise<XThread> {
  requireCredentials(ctx.credentials);
  const id = normaliseId(input.id);
  if (!id) throw new SearchError('configuration', 'Pass a post URL or a numeric post id.');
  const transport: DiscoveryTransport = {
    credentials: { ...ctx.credentials, lang: ctx.credentials.lang ?? DEFAULT_LANG },
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
    ...(ctx.fetch ? { fetchImpl: ctx.fetch } : {}),
  };
  const target = { pageUrl: statusUrl(`https://x.com/i/web/status/${id}`), operationName: THREAD_OPERATION };
  const limit = Math.max(1, Math.min(input.limit, MAX_REPLIES));
  let operation = await operations.get(transport, target);
  let body = await readThread(transport, operation, id, ctx);
  if (body === 'stale') {
    operation = await operations.get(transport, target, true);
    body = await readThread(transport, operation, id, ctx);
    if (body === 'stale') throw new SearchError('protocol', `X rejected the ${THREAD_OPERATION} query id twice after rediscovery. ${MAINTAINER_ACTION}`);
  }
  return parseThread(body, { limit, depth: input.depth, maxChars: input.maxChars });
}

/** Accept a full permalink, a status URL or a bare id. */
export function normaliseId(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^\d{1,25}$/.test(trimmed)) return trimmed;
  const match = /\/status(?:es)?\/(\d{1,25})/.exec(trimmed);
  return match?.[1];
}

async function readThread(
  transport: DiscoveryTransport,
  operation: { queryId: string; variables: Record<string, unknown> },
  id: string,
  ctx: XThreadContext,
): Promise<Record<string, unknown> | 'stale'> {
  const variables = { ...operation.variables, focalTweetId: id, withFocalTweet: true, cursor: null };
  const url = `${GRAPHQL_BASE}/${operation.queryId}/${THREAD_OPERATION}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
  const fetcher = ctx.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url, { headers: apiHeaders(transport.credentials), redirect: 'follow', signal: requestSignal(ctx.signal, ctx.timeoutMs) });
  } catch (error) {
    throw mapThrown(error, ctx.signal, ctx.timeoutMs, 'the x.com post API');
  }
  if (response.status === 401 || response.status === 403) throw authFailure(response.status);
  if (response.status === 429) throw new SearchError('rate-limit', 'X rate limit reached; wait before asking again.', 429);
  if (response.status === 404) return 'stale';
  if (!response.ok) throw new SearchError('http', `X returned HTTP ${response.status} for the post API.`, response.status);
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    throw mapThrown(error, ctx.signal, ctx.timeoutMs, 'the x.com post API');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SearchError('protocol', 'X returned a post response that is not JSON.');
  }
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0 && !body.data) {
    const message = (errors[0] as { message?: unknown } | undefined)?.message;
    throw new SearchError('protocol', `X rejected the ${THREAD_OPERATION} variables (${typeof message === 'string' ? message.slice(0, 160) : 'no message'}). ${MAINTAINER_ACTION}`);
  }
  return body;
}
