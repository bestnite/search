// Access tokens for the two Reddit read paths.
//
//   anonymous: the application-only token of the official Android client, obtained from the loid
//              endpoint with a Basic(<android client id>:) header and the device header set. It is
//              the only token the gql-fed.reddit.com persisted operations accept.
//   oauth:     a regular OAuth token from www.reddit.com/api/v1/access_token with HTTP Basic
//              (clientId:clientSecret); grant_type=password when a username/password pair is given,
//              grant_type=client_credentials otherwise.
//
// Tokens are cached per process and refreshed shortly before they expire. A 401 refreshes once, a
// 429 rotates the token once; nothing else retries, and neither mode ever falls back to the other.
// Endpoints, the Android client id and the request bodies are copied from
// bestnite/reddit-readonly-mcp (src/auth/token-manager.ts, src/config.ts) - do not rewrite them.

import { SearchError } from '../transport.js';
import { getProcessDevice, type AndroidDevice } from './device.js';
import { PROJECT_URL, VERSION } from '../version.js';

/** Application-only (anonymous) token endpoint of the official Android client. */
export const ANONYMOUS_TOKEN_URL = 'https://www.reddit.com/auth/v2/oauth/access-token/loid';
export const OAUTH_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
/** Client id of the official Reddit Android client, exactly as the source repo ships it. */
export const ANDROID_CLIENT_ID = 'ohXpoqrZYub1kg';
export const ANONYMOUS_TOKEN_BODY = JSON.stringify({ scopes: ['*', 'email', 'pii'] });
/** Refresh this long before the reported expiry. */
export const TOKEN_REFRESH_MARGIN_MS = 120_000;
/** Reddit wants a descriptive agent on oauth calls; the Android UA is only used for anonymous ones. */
// The OAuth path identifies this client as itself; Reddit expects a descriptive agent
// string there. The anonymous path impersonates the Android client and never uses this.
export const REDDIT_USER_AGENT = `dsh-search/${VERSION} (Reddit read-only client; +${PROJECT_URL})`;
/** Upper bound for a single 429 back-off in the retry layer. */
export const MAX_RETRY_WAIT_MS = 60_000;

export type RedditMode = 'oauth' | 'anonymous';

export interface RedditCredentials {
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
}

export interface RedditAuthOptions {
  mode: RedditMode;
  credentials: RedditCredentials;
  signal: AbortSignal;
  timeoutMs: number;
  device?: AndroidDevice;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface Access {
  headers: Record<string, string>;
  generation: number;
  mode: RedditMode;
}

interface TokenState {
  token: string;
  expiresAt: number;
  /** x-reddit-loid / x-reddit-session, replayed on every anonymous request. */
  sessionHeaders: Record<string, string>;
}

const tokenCache = new Map<string, TokenState>();
const inflight = new Map<string, Promise<TokenState>>();
let generationCounter = 0;

/** Test seam: forget every cached token so the next call fetches a fresh one. */
export function resetRedditTokenCache(): void {
  tokenCache.clear();
  inflight.clear();
}

/** Rejects a context that cannot possibly authenticate, before any request is sent. */
export function requireCredentials(mode: RedditMode, credentials: RedditCredentials): void {
  if (mode !== 'oauth') return;
  if (!credentials.clientId?.trim() || !credentials.clientSecret?.trim()) {
    throw new SearchError(
      'configuration',
      'Reddit oauth mode needs both a client id and a client secret.',
    );
  }
  if (credentials.username && !credentials.password) {
    throw new SearchError('configuration', 'Reddit oauth mode got a username without a password.');
  }
  if (credentials.password && !credentials.username) {
    throw new SearchError('configuration', 'Reddit oauth mode got a password without a username.');
  }
}

/** Cached token identity; deliberately built without any secret text. */
function cacheKey(mode: RedditMode, credentials: RedditCredentials): string {
  const client = mode === 'anonymous' ? (credentials.clientId ?? ANDROID_CLIENT_ID) : (credentials.clientId ?? '');
  const user = mode === 'oauth' ? (credentials.username ?? '') : '';
  return `${mode}|${client}|${user}|${credentials.password ? 'pw' : ''}`;
}

export class RedditAuth {
  readonly mode: RedditMode;
  private readonly credentials: RedditCredentials;
  private readonly device: AndroidDevice;
  private readonly fetchImpl: typeof fetch;
  private readonly signal: AbortSignal;
  private readonly timeoutMs: number;
  private readonly key: string;
  private generation = 0;

  constructor(options: RedditAuthOptions) {
    this.mode = options.mode;
    this.credentials = options.credentials;
    this.device = options.device ?? getProcessDevice();
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.signal = options.signal;
    this.timeoutMs = options.timeoutMs;
    this.key = cacheKey(options.mode, options.credentials);
    requireCredentials(options.mode, options.credentials);
  }

  /** True when this instance would have to talk to Reddit before a data request can be sent. */
  get hasCachedToken(): boolean {
    return isFresh(tokenCache.get(this.key));
  }

  async access(): Promise<Access> {
    const state = await this.token(false);
    return { headers: this.buildHeaders(state), generation: this.generation, mode: this.mode };
  }

  /** 401: drop the cached token and take a new one. */
  async refresh(): Promise<void> {
    await this.token(true);
  }

  /** 429: rotate the token; keep the current one when no new token can be had. */
  async rotate(): Promise<void> {
    try {
      await this.token(true);
    } catch {
      // The caller waits out the rate limit with the token it already has.
    }
  }

  /** Token request for the current mode; exported shape is used by the tests. */
  buildTokenRequest(): { url: string; init: RequestInit & { headers: Record<string, string> } } {
    if (this.mode === 'anonymous') {
      const clientId = this.credentials.clientId?.trim() || ANDROID_CLIENT_ID;
      return {
        url: ANONYMOUS_TOKEN_URL,
        init: {
          method: 'POST',
          headers: { ...this.device.headers, Authorization: basicAuth(clientId, '') },
          body: ANONYMOUS_TOKEN_BODY,
        },
      };
    }

    const clientId = this.credentials.clientId!.trim();
    const clientSecret = this.credentials.clientSecret!.trim();
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': REDDIT_USER_AGENT,
      Authorization: basicAuth(clientId, clientSecret),
    };
    const grant =
      this.credentials.username && this.credentials.password
        ? `grant_type=password&username=${encodeURIComponent(this.credentials.username)}&password=${encodeURIComponent(this.credentials.password)}`
        : 'grant_type=client_credentials';
    return { url: OAUTH_TOKEN_URL, init: { method: 'POST', headers, body: grant } };
  }

  // -------------------------------------------------------------------------

  private async token(force: boolean): Promise<TokenState> {
    const cached = tokenCache.get(this.key);
    if (!force && isFresh(cached)) return cached;

    const pending = inflight.get(this.key);
    if (pending) return pending;

    const request = this.fetchToken()
      .then((state) => {
        tokenCache.set(this.key, state);
        this.generation = ++generationCounter;
        return state;
      })
      .finally(() => {
        inflight.delete(this.key);
      });
    inflight.set(this.key, request);
    return request;
  }

  private async fetchToken(): Promise<TokenState> {
    const { url, init } = this.buildTokenRequest();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        redirect: 'manual',
        signal: requestSignal(this.signal, this.timeoutMs),
      });
    } catch (error) {
      throw mapThrown(error, this.signal, this.timeoutMs, 'the Reddit token endpoint');
    }

    const text = await response.text().catch(() => '');
    if (!response.ok) throw this.statusError(response.status);

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new SearchError('protocol', 'Reddit answered the token endpoint with something that is not JSON.');
    }
    const body = payload as { access_token?: unknown; expires_in?: unknown };
    const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
    const expiresIn = Number(body.expires_in);
    if (accessToken === '' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new SearchError('protocol', 'Reddit token response carried no access_token/expires_in.');
    }

    const sessionHeaders: Record<string, string> = {};
    for (const name of ['x-reddit-loid', 'x-reddit-session']) {
      const value = response.headers.get(name);
      if (value) sessionHeaders[name] = value;
    }
    return { token: accessToken, expiresAt: Date.now() + expiresIn * 1000, sessionHeaders };
  }

  private buildHeaders(state: TokenState): Record<string, string> {
    if (this.mode === 'anonymous') {
      return { ...this.device.headers, ...state.sessionHeaders, Authorization: `Bearer ${state.token}` };
    }
    return {
      'User-Agent': REDDIT_USER_AGENT,
      Accept: 'application/json',
      Authorization: `Bearer ${state.token}`,
    };
  }

  private statusError(status: number): SearchError {
    const what = this.mode === 'anonymous' ? 'the anonymous token endpoint' : 'the OAuth token endpoint';
    if (status === 401 || status === 403) {
      return new SearchError(
        'authentication',
        this.mode === 'anonymous'
          ? 'Reddit blocked the anonymous application-only token request; the anonymous path is refused from this network, so oauth mode with your own client id and secret is required.'
          : 'Reddit rejected the OAuth token request; the client id/secret (or username/password) is invalid.',
        status,
      );
    }
    if (status === 429) return new SearchError('rate-limit', `Reddit rate-limited ${what}.`, status);
    if (status >= 500) return new SearchError('network', `Reddit is unavailable (HTTP ${status}) at ${what}.`, status);
    return new SearchError('protocol', `Reddit returned an unexpected HTTP ${status} from ${what}.`, status);
  }
}

function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

function isFresh(state: TokenState | undefined): state is TokenState {
  return state !== undefined && Date.now() < state.expiresAt - TOKEN_REFRESH_MARGIN_MS;
}

/** Deadline for one request: the caller's signal plus this call's timeout. */
export function requestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

/** fetch() rejects with AbortError for both cancellation and deadline; only the deadline exists here. */
export function mapThrown(error: unknown, signal: AbortSignal, timeoutMs: number, what: string): SearchError {
  if (error instanceof SearchError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError' || signal.aborted) {
    return new SearchError('timeout', `Request for ${what} was aborted or exceeded ${timeoutMs} ms.`);
  }
  return new SearchError('network', `Network error while requesting ${what}; check connectivity.`);
}

/** Kind for a non-2xx data response. The messages never echo the upstream body. */
export function statusError(status: number, what: string, mode: RedditMode): SearchError {
  if (status === 401 || status === 403) {
    return new SearchError(
      'authentication',
      mode === 'anonymous'
        ? `Reddit refused the anonymous request for ${what}; the anonymous path is blocked from this network, so oauth mode with your own credentials is required.`
        : `Reddit rejected the credentials while reading ${what}; check that the client id/secret (or username/password) is valid.`,
      status,
    );
  }
  if (status === 429) return new SearchError('rate-limit', `Reddit rate-limited the request for ${what}.`, status);
  if (status >= 500) return new SearchError('network', `Reddit is unavailable (HTTP ${status}) for ${what}.`, status);
  return new SearchError('protocol', `Reddit returned HTTP ${status} for ${what}.`, status);
}

/** Seconds/date from a Retry-After or x-ratelimit-reset header, capped by MAX_RETRY_WAIT_MS. */
export function retryAfterMs(headers: Headers): number {
  const raw = headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_WAIT_MS);
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset) {
    const seconds = Number(reset);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
  }
  return 0;
}
