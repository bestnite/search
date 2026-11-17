import type { Source } from '../types.js';
import { SearchError } from '../transport.js';
import { searchXOfficial } from './official.js';
import { searchXSession, type SessionCredential } from './session.js';

export type { SessionCredential };

export interface XCredentials { bearerToken?: string; authToken?: string; ct0?: string; lang?: string }

export interface XContext {
  mode: 'key' | 'session';
  credentials: XCredentials;
  signal: AbortSignal;
  timeoutMs: number;
  /** Cap on posts read per search; billing is per post in official mode. */
  postsPerSearch?: number;
  fetch?: typeof fetch;
}

/**
 * Dispatch on the configured mode and never across modes: a missing or rejected
 * credential fails loudly instead of quietly trying the other path.
 */
/**
 * Accept the two shapes people actually paste: a JSON document, or the raw cookie
 * header copied from DevTools. Anything else is a configuration error that names
 * both accepted forms instead of blaming the parser.
 */
export function parseXCredentials(raw: string | undefined): XCredentials {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as XCredentials;
    } catch {
      // fall through to the cookie-header form below
    }
  }
  const cookie = (name: string): string | undefined => new RegExp(`(?:^|[;\\s])${name}=([^;\\s]+)`).exec(trimmed)?.[1];
  const authToken = cookie('auth_token');
  const ct0 = cookie('ct0');
  if (authToken && ct0) return { authToken, ct0 };
  throw new SearchError('configuration', 'The stored X credential is neither valid JSON nor a cookie header. Use {"authToken":"…","ct0":"…"} or paste auth_token=…; ct0=… from the browser.');
}

export async function searchX(input: { query: string; maxResults: number }, ctx: XContext): Promise<Source[]> {
  if (ctx.mode === 'key') {
    const token = ctx.credentials.bearerToken;
    if (!token) throw new SearchError('configuration', 'X key mode needs a bearerToken. Store the app-only bearer token as a credential.');
    return searchXOfficial(input, { bearerToken: token, signal: ctx.signal, timeoutMs: ctx.timeoutMs, postsPerSearch: ctx.postsPerSearch, fetch: ctx.fetch });
  }
  const { authToken, ct0, lang } = ctx.credentials;
  if (!authToken || !ct0) throw new SearchError('configuration', 'X session mode needs authToken and ct0 from the user\'s signed-in X browser session.');
  return searchXSession(input, { credentials: { authToken, ct0, lang }, signal: ctx.signal, timeoutMs: ctx.timeoutMs, fetch: ctx.fetch });
}
