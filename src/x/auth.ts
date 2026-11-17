import { SearchError } from '../transport.js';

/** Public web-app bearer, shipped in every X bundle. Not a secret; the cookies are. */
export const WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

/** A real browser UA: X answers 404 to Node's default agent on several endpoints. */
export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export const DEFAULT_LANG = 'en';
export const GRAPHQL_BASE = 'https://x.com/i/api/graphql';
export const SEARCH_PAGE = 'https://x.com/search';

/** Everything the caller must supply, and nothing else. */
export interface SessionCredential {
  authToken: string;
  ct0: string;
  lang?: string;
}

export function requireCredentials(credentials: SessionCredential | undefined): asserts credentials is SessionCredential {
  if (!credentials?.authToken || !credentials.ct0) {
    throw new SearchError('configuration', 'X session mode needs authToken and ct0 from the user\'s signed-in X browser session.');
  }
}

export function cookieHeader(credentials: SessionCredential): string {
  return `auth_token=${credentials.authToken}; ct0=${credentials.ct0}; lang=${credentials.lang ?? DEFAULT_LANG}`;
}

/** Headers for the HTML page that carries the search operation's query id. */
export function pageHeaders(credentials: SessionCredential): Record<string, string> {
  return {
    cookie: cookieHeader(credentials),
    'user-agent': USER_AGENT,
    'accept-language': 'en-US,en;q=0.9',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
}

/** Headers for the GraphQL read: cookie plus the public bearer and the CSRF token. */
export function apiHeaders(credentials: SessionCredential): Record<string, string> {
  return {
    cookie: cookieHeader(credentials),
    authorization: `Bearer ${WEB_BEARER}`,
    'x-csrf-token': credentials.ct0,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-client-language': credentials.lang ?? DEFAULT_LANG,
    'user-agent': USER_AGENT,
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    accept: '*/*',
    referer: 'https://x.com/',
  };
}

export function requestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

/** Action text every maintenance failure carries, so the user knows a code change is needed. */
export const MAINTAINER_ACTION = 'X changed its front-end search operation, so this adapter needs a maintainer update.';

export function mapThrown(error: unknown, signal: AbortSignal, timeoutMs: number, what: string): SearchError {
  if (error instanceof SearchError) return error;
  if (signal.aborted) return new SearchError('cancelled', `The request for ${what} was cancelled.`);
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new SearchError('timeout', `Timed out after ${timeoutMs} ms while requesting ${what}.`);
  }
  return new SearchError('network', `Could not reach ${what}; check connectivity.`);
}

export function authFailure(status: number): SearchError {
  return new SearchError('authentication', `x.com rejected the session with HTTP ${status}. Sign in to X in a browser and copy auth_token and ct0 again.`, status);
}

export function rateLimitFailure(status: number): SearchError {
  return new SearchError('rate-limit', 'X rate limit reached for this session; wait before asking again.', status);
}

export function httpFailure(status: number, what: string): SearchError {
  return new SearchError('http', `X returned HTTP ${status} for ${what}.`, status);
}

export function staleFailure(detail: string): SearchError {
  return new SearchError('protocol', `${detail} ${MAINTAINER_ACTION}`);
}
