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
