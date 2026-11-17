import { PROJECT_URL, VERSION } from './version.js';

/**
 * One identity for every request this plugin makes that can carry one.
 *
 * Two paths deliberately opt out, because they impersonate a first-party client
 * and a foreign agent string would break them:
 * - Reddit anonymous mode sends the Android client's device headers.
 * - X session mode sends the web client's browser headers for the signing
 *   handshake and the GraphQL call.
 * Both set their own User-Agent, so `withAppUserAgent` leaves them alone.
 */
export const APP_USER_AGENT = `dsh-search/${VERSION} (+${PROJECT_URL})`;

const hasUserAgent = (headers: Record<string, string>): boolean => Object.keys(headers).some(name => name.toLowerCase() === 'user-agent');

/** Add the plugin identity unless the caller already chose one. */
export function withAppUserAgent(headers: Record<string, string> = {}): Record<string, string> {
  return hasUserAgent(headers) ? headers : { ...headers, 'User-Agent': APP_USER_AGENT };
}

/** Same rule for the transport layer, which receives any HeadersInit shape. */
export function initWithAppUserAgent(init: RequestInit): RequestInit {
  const raw = init.headers;
  if (raw instanceof Headers) {
    if (raw.has('user-agent')) return init;
    const headers = new Headers(raw);
    headers.set('User-Agent', APP_USER_AGENT);
    return { ...init, headers };
  }
  if (Array.isArray(raw)) {
    if (raw.some(([name]) => String(name).toLowerCase() === 'user-agent')) return init;
    return { ...init, headers: [...raw, ['User-Agent', APP_USER_AGENT]] };
  }
  return { ...init, headers: withAppUserAgent((raw ?? {}) as Record<string, string>) };
}
