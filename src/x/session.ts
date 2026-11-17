// X search over a browser session cookie: the reverse-engineered internal GraphQL path.
//
// Ported from bestnite/x-mcp (src/x/client.ts + src/x/api.ts search, restricted to SearchTimeline).
// One request shape, one retry story, nothing else:
//
//   GET https://x.com/i/api/graphql/<queryId>/SearchTimeline?variables=…&features=…&fieldToggles=…
//
// Three things X can rotate, and what each failure means for the caller:
//   - cookie pair        -> 401/403, authentication, the user signs in to x.com again
//   - queryId table      -> 404/422, repaired by re-reading main.js
//   - signing chain      -> 404/422 too, repaired by rebuilding the signer
//
// A 404/422 cannot tell those last two apart, so both repairs run in order before giving up. There
// is no fallback to another endpoint or mode on purpose: a stale signature must look stale rather
// than quietly degrade into a different, possibly unauthenticated, source of results.

import { SearchError } from '../transport.js';
import type { Source } from '../types.js';
import {
  GRAPHQL_BASE,
  apiHeaders,
  authFailure,
  extractXCode,
  httpFailure,
  MAINTAINER_ACTION,
  mapThrown,
  rateLimitFailure,
  requestSignal,
  requireCredentials,
  staleFailure,
  type XTransport,
} from './auth.js';
import { OperationsRegistry } from './operations.js';
import { parseSearchInstructions, toSource } from './parse.js';
import { ClientTransaction, ClientTransactionIdError, SourceFetchError, textFetcher } from './tid.js';

export interface SessionCredential {
  authToken: string;
  ct0: string;
  lang?: string;
}

export interface SessionContext {
  credentials: SessionCredential;
  signal: AbortSignal;
  timeoutMs: number;
  fetch?: typeof fetch;
}

/** SearchTimeline answers at most 40 posts per page; X truncates or errors above that. */
const MAX_RESULTS_PER_REQUEST = 40;
/** The web client's own value for the "Latest" tab; "Top" would order by engagement instead. */
const SEARCH_PRODUCT = 'Latest';
const SEARCH_OPERATION = 'SearchTimeline';

/** Everything cached across calls: the queryId table and the built signer. */
interface SessionState {
  operations: OperationsRegistry;
  signer: ClientTransaction | null;
}

let cached: SessionState | null = null;

function state(): SessionState {
  cached ??= { operations: new OperationsRegistry(), signer: null };
  return cached;
}

/** Test seam: forget the operation table and the signer so the next call re-derives both. */
export function resetXSessionState(): void {
  cached = null;
}

/** Search posts and map them to Sources. Only the SearchTimeline path exists here. */
export async function searchXSession(
  input: { query: string; maxResults: number },
  ctx: SessionContext,
): Promise<Source[]> {
  const query = input.query?.trim() ?? '';
  if (query === '') {
    throw new SearchError('configuration', 'X session search needs a non-empty query.');
  }
  // Both checks run before the first request, so a misconfigured backend costs zero sends.
  requireCredentials(ctx.credentials);
  if (!Number.isFinite(ctx.timeoutMs) || ctx.timeoutMs <= 0) {
    throw new SearchError('configuration', 'X session search needs a positive timeout.');
  }
  if (!Number.isFinite(input.maxResults) || input.maxResults < 1) {
    throw new SearchError('configuration', 'X session search needs maxResults to be at least 1.');
  }

  const transport: XTransport = {
    credentials: ctx.credentials,
    fetchImpl: ctx.fetch ?? ((...args) => fetch(...args)),
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
  };
  const maxResults = Math.min(Math.trunc(input.maxResults), MAX_RESULTS_PER_REQUEST);

  const data = await graphql(transport, SEARCH_OPERATION, {
    rawQuery: query,
    count: maxResults,
    product: SEARCH_PRODUCT,
    querySource: 'typed_query',
  });

  return parseSearchInstructions(data)
    .slice(0, maxResults)
    .map((tweet) => toSource(tweet));
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

type FailureKind = 'auth' | 'stale' | 'rate' | 'error';

interface Failure {
  ok: false;
  kind: FailureKind;
  status: number;
  /** X's numeric error code, used only to word the message; the body itself is dropped. */
  xCode?: number;
}

type Attempt<T> = { ok: true; data: T } | Failure;

async function graphql<T>(
  transport: XTransport,
  operationName: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const what = `The X ${operationName} request`;
  const first = await send<T>(transport, operationName, variables);
  if (first.ok) return first.data;
  throwIfNotStale(first, what);

  // The first answer was 404/422. Re-read the queryId table once; a rotation is by far the common
  // cause. A failed re-read is not fatal on its own, because the signer may still be the culprit.
  try {
    await state().operations.refresh(true, transport);
    const retried = await send<T>(transport, operationName, variables);
    if (retried.ok) return retried.data;
    throwIfNotStale(retried, what);
  } catch (error) {
    if (rejectsImmediately(error)) throw error;
    // Fall through: the queryId table could not be rebuilt, or the retry was stale again.
  }

  // The queryId was not the problem, so the signing key/chain rotated underneath us. Rebuild the
  // signer once and try a third and final time; a second 404/422 is reported as a maintainer task.
  state().signer = null;
  const third = await send<T>(transport, operationName, variables).catch((error: unknown) => {
    if (error instanceof SearchError) throw error;
    throw staleFailure(what, first.status);
  });
  if (third.ok) return third.data;
  if (third.kind !== 'stale') throwIfNotStale(third, what);
  throw staleFailure(what, third.status);
}

/**
 * Turn a failure that is not a staleness signal into its final error. A 'stale' failure is left to
 * the caller, which is the only place that knows whether both repairs have been tried yet.
 */
function throwIfNotStale(failure: Failure, what: string): void {
  if (failure.kind === 'auth') throw authFailure(failure.status, what, failure.xCode);
  if (failure.kind === 'rate') throw rateLimitFailure(what);
  if (failure.kind === 'error') throw httpFailure(failure.status, what);
}

/** Errors that no amount of re-extraction can fix; they escape the recovery block unchanged. */
function rejectsImmediately(error: unknown): boolean {
  return (
    error instanceof SearchError &&
    (error.kind === 'authentication' ||
      error.kind === 'rate-limit' ||
      error.kind === 'timeout' ||
      error.kind === 'cancelled')
  );
}

/** One signed attempt: operation table, signer, transaction id, request, classification. */
async function send<T>(
  transport: XTransport,
  operationName: string,
  variables: Record<string, unknown>,
): Promise<Attempt<T>> {
  const operation = await state().operations.get(operationName, transport);
  const signer = await signerFor(transport);

  // The signed path is the request path without the host and without the query string.
  const path = `/i/api/graphql/${operation.queryId}/${operation.operationName}`;
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(operation.features),
  });
  if (operation.fieldToggles.length > 0) {
    params.set(
      'fieldToggles',
      JSON.stringify(Object.fromEntries(operation.fieldToggles.map((name) => [name, true]))),
    );
  }
  const url = `${GRAPHQL_BASE}/${operation.queryId}/${operation.operationName}?${params.toString()}`;
  const transactionId = signer.generateTransactionId('GET', path);

  let response: Response;
  try {
    response = await transport.fetchImpl(url, {
      headers: apiHeaders(transport.credentials, transactionId),
      redirect: 'manual',
      signal: requestSignal(transport.signal, transport.timeoutMs),
    });
  } catch (error) {
    throw mapThrown(error, transport.signal, transport.timeoutMs, `the X ${operationName} request`);
  }

  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    throw mapThrown(error, transport.signal, transport.timeoutMs, `the X ${operationName} response`);
  }

  if (!response.ok) return classify(response.status, text);

  let payload: { data?: T };
  try {
    payload = JSON.parse(text) as { data?: T };
  } catch {
    throw new SearchError('protocol', `X answered ${operationName} with something that is not JSON.`);
  }
  if (payload.data === undefined || payload.data === null) {
    // A successful status with no payload is a shape change, not an empty result set.
    throw new SearchError('protocol', `X returned no data payload for ${operationName}.`);
  }
  return { ok: true, data: payload.data };
}

function classify(status: number, body: string): Failure {
  const xCode = extractXCode(body);
  if (status === 401 || status === 403) return { ok: false, kind: 'auth', status, xCode };
  if (status === 429) return { ok: false, kind: 'rate', status, xCode };
  // 422 is what X answers a queryId/features mismatch with; 404 when the operation path is gone.
  if (status === 404 || status === 422) return { ok: false, kind: 'stale', status, xCode };
  return { ok: false, kind: 'error', status, xCode };
}

// ---------------------------------------------------------------------------
// Signer
// ---------------------------------------------------------------------------

async function signerFor(transport: XTransport): Promise<ClientTransaction> {
  const existing = state().signer;
  if (existing) return existing;
  try {
    const signer = await ClientTransaction.initialize(textFetcher(transport));
    state().signer = signer;
    return signer;
  } catch (error) {
    throw signerFailure(error, transport);
  }
}

/** Signer build errors keep their cause: cookie death, transport, or a broken X front end. */
function signerFailure(error: unknown, transport: XTransport): SearchError {
  if (error instanceof SourceFetchError) {
    const status = error.statusCode;
    if (status === undefined) {
      return new SearchError('network', 'Could not fetch x.com to build the signer; check connectivity.');
    }
    if (status === 401 || status === 403) {
      return authFailure(status, 'x.com while building the signer');
    }
    return httpFailure(status, 'x.com while building the signer');
  }
  if (error instanceof ClientTransactionIdError) {
    return new SearchError(
      'protocol',
      `The x-client-transaction-id signer broke: ${error.message}. ${MAINTAINER_ACTION}`,
    );
  }
  return mapThrown(error, transport.signal, transport.timeoutMs, 'x.com while building the signer');
}
