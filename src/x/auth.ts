// X web-session headers and failure mapping for the reverse-engineered GraphQL search path.
//
// Ported from bestnite/x-mcp (src/x/auth.ts + src/config.ts SessionCookies). Three dependencies can
// rot independently, and each reports itself differently:
//   - the cookie pair (auth_token/ct0)  -> 401/403
//   - the queryId table                -> 404 / 422
//   - the transaction-id signing chain -> 404, indistinguishable from a rotated queryId
//
// The bearer below is the constant the x.com web client ships to every visitor; it is not a secret.
// What is secret is the cookie pair, so no message built here, and no value returned anywhere, may
// echo a cookie, a header value, the bearer, or an upstream response body. Status codes and failure
// classes are the only detail that leaves this module.

import { SearchError } from '../transport.js';
import type { SessionCredential } from './session.js';

/** Public bearer of the x.com web client; X rarely rotates it. */
export const WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export const GRAPHQL_BASE = 'https://x.com/i/api/graphql';

/** x.com serves the search page in this language unless the cookie says otherwise. */
export const DEFAULT_LANG = 'en';

/**
 * Closing sentence every queryId/signature staleness message must carry: the user cannot fix it,
 * only whoever maintains this adapter can, and the message has to say so.
 */
export const MAINTAINER_ACTION =
  'X changed its front-end signing or queryId, so this adapter needs a maintainer update.';

/** The transport a single search call was handed: fetcher, deadline and the cookie pair. */
export interface XTransport {
  credentials: SessionCredential;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  timeoutMs: number;
}

export function cookieHeader(credentials: SessionCredential): string {
  return `auth_token=${credentials.authToken}; ct0=${credentials.ct0}; lang=${credentials.lang ?? DEFAULT_LANG}`;
}

/** Headers for fetching x.com pages (home, main.js): no authorization, closest to a browser. */
export function webHeaders(credentials: SessionCredential): Record<string, string> {
  return {
    'user-agent': USER_AGENT,
    'accept-language': 'en-US,en;q=0.9',
    cookie: cookieHeader(credentials),
  };
}

/** Headers for the internal API. The transaction id is supplied by the caller, per request. */
export function apiHeaders(
  credentials: SessionCredential,
  transactionId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...webHeaders(credentials),
    authorization: `Bearer ${WEB_BEARER}`,
    'x-csrf-token': credentials.ct0,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-client-language': credentials.lang ?? DEFAULT_LANG,
    'content-type': 'application/json',
    accept: '*/*',
    referer: 'https://x.com/',
  };
  if (transactionId) headers['x-client-transaction-id'] = transactionId;
  return headers;
}

/** Rejects a context that cannot possibly authenticate, before a single request is sent. */
export function requireCredentials(credentials: SessionCredential | undefined): void {
  if (!credentials?.authToken?.trim() || !credentials?.ct0?.trim()) {
    throw new SearchError(
      'configuration',
      'X session search needs both auth_token and ct0: open x.com while signed in, read those two cookie values from the browser, and store them as the backend credential.',
    );
  }
}

/** Deadline for one request: the caller's signal plus this call's timeout. */
export function requestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

/** fetch() rejects with AbortError for both cancellation and deadline; only the deadline exists here. */
export function mapThrown(
  error: unknown,
  signal: AbortSignal,
  timeoutMs: number,
  what: string,
): SearchError {
  if (error instanceof SearchError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError' || signal.aborted) {
    return new SearchError('timeout', `Request for ${what} was aborted or exceeded ${timeoutMs} ms.`);
  }
  return new SearchError('network', `Network error while requesting ${what}; check connectivity.`);
}

/** 401/403: the cookie pair is gone, and only a fresh browser session can replace it. */
export function authFailure(status: number, what: string, xCode?: number): SearchError {
  const detail =
    status === 401
      ? 'the session cookie (auth_token) is no longer accepted'
      : xCode === 353
        ? 'the csrf token (ct0) does not match auth_token'
        : xCode === 326
          ? 'the account is temporarily locked'
          : xCode === 64
            ? 'the account is suspended'
            : 'the cookie pair was refused';
  return new SearchError(
    'authentication',
    `${what} returned HTTP ${status}: ${detail}. The X session expired, so the user has to sign in to x.com in a browser again and store the fresh auth_token and ct0.`,
    status,
  );
}

export function rateLimitFailure(what: string): SearchError {
  return new SearchError('rate-limit', `${what} hit the X rate limit; retry later.`, 429);
}

/** A queryId or signing-chain loss survived both repairs; nothing the caller can do but report. */
export function staleFailure(what: string, status: number): SearchError {
  return new SearchError(
    'protocol',
    `${what} returned HTTP ${status} even after refreshing the queryId table and rebuilding the signer. ${MAINTAINER_ACTION}`,
    status,
  );
}

/** Any other status: 5xx is transport trouble, everything else is an unexpected protocol answer. */
export function httpFailure(status: number, what: string): SearchError {
  return status >= 500
    ? new SearchError('network', `${what} returned HTTP ${status}; X looks unavailable.`, status)
    : new SearchError('protocol', `${what} returned an unexpected HTTP ${status}.`, status);
}

/** X error bodies carry a numeric code; only the code is read, never the body itself. */
export function extractXCode(body: string): number | undefined {
  const match = /"code"\s*:\s*(\d+)/.exec(body);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}
