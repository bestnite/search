import { randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'wsm_session';
const IDLE_MS = 15 * 60_000;
const ABSOLUTE_MS = 24 * 60 * 60_000;

/**
 * The token arrives from the environment, is exchanged once for an HttpOnly cookie, and lives only in
 * this process: nothing here touches the disk.
 */
export class SessionStore {
  private readonly sessions = new Map<string, { created: number; seen: number; ip: string }>();
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly absoluteMs: number;

  constructor(private readonly token: string, options: { idleMs?: number; absoluteMs?: number; now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.absoluteMs = options.absoluteMs ?? ABSOLUTE_MS;
  }

  /** Constant-time: a timing side channel here would be a slower way to guess the token. */
  verify(candidate: string | undefined): boolean {
    if (!candidate) return false;
    const given = Buffer.from(candidate);
    const expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  issue(ip: string): string {
    const id = randomBytes(32).toString('base64url');
    const at = this.now();
    this.sessions.set(id, { created: at, seen: at, ip });
    return id;
  }

  check(id: string | undefined): boolean {
    if (!id) return false;
    const session = this.sessions.get(id);
    if (!session) return false;
    const at = this.now();
    if (at - session.seen > this.idleMs || at - session.created > this.absoluteMs) {
      this.sessions.delete(id);
      return false;
    }
    session.seen = at;
    return true;
  }

  revoke(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Drops idle sessions so a long-lived process does not accumulate them. */
  prune(): void {
    const at = this.now();
    for (const [id, session] of this.sessions) {
      if (at - session.seen > this.idleMs || at - session.created > this.absoluteMs) this.sessions.delete(id);
    }
  }
}

/** Failed token guesses are throttled per address: the token is the only thing between the page and the file. */
export class FailureLimiter {
  private readonly hits = new Map<string, { count: number; until: number }>();

  constructor(private readonly limit = 10, private readonly banMs = 5 * 60_000, private readonly now: () => number = () => Date.now()) {}

  blocked(ip: string): boolean {
    const entry = this.hits.get(ip);
    if (!entry) return false;
    if (entry.until > this.now()) return true;
    if (entry.until !== 0) this.hits.delete(ip);
    return false;
  }

  fail(ip: string): void {
    const entry = this.hits.get(ip) ?? { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= this.limit) entry.until = this.now() + this.banMs;
    this.hits.set(ip, entry);
  }

  clear(ip: string): void {
    this.hits.delete(ip);
  }
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function sessionCookie(id: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}
