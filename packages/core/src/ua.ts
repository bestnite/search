import { PROJECT_URL, VERSION } from './version.js';

/**
 * Every request this library makes identifies its caller. A host that wants its own name in front
 * of the library's call it must say so through `setUserAgent`; otherwise the library names itself.
 */
let override: string | undefined;

export function setUserAgent(value: string | undefined): void {
  override = value;
}

export function appUserAgent(): string {
  return override ?? `search-core/${VERSION} (+${PROJECT_URL})`;
}

const hasUserAgent = (headers: Record<string, string>): boolean => Object.keys(headers).some(name => name.toLowerCase() === 'user-agent');

/** Add the caller identity unless the request already chose one (impersonation paths do). */
export function withAppUserAgent(headers: Record<string, string> = {}): Record<string, string> {
  return hasUserAgent(headers) ? headers : { ...headers, 'User-Agent': appUserAgent() };
}

/** Same rule for the transport layer, which receives any HeadersInit shape. */
export function initWithAppUserAgent(init: RequestInit): RequestInit {
  const raw = init.headers;
  if (raw instanceof Headers) {
    if (raw.has('user-agent')) return init;
    const headers = new Headers(raw);
    headers.set('User-Agent', appUserAgent());
    return { ...init, headers };
  }
  if (Array.isArray(raw)) {
    if (raw.some(([name]) => String(name).toLowerCase() === 'user-agent')) return init;
    return { ...init, headers: [...raw, ['User-Agent', appUserAgent()]] };
  }
  return { ...init, headers: withAppUserAgent((raw ?? {}) as Record<string, string>) };
}
