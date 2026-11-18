import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';

export const SESSION_COOKIE = 'wsm_session';
const IDLE_MS = 15 * 60_000;
const ABSOLUTE_MS = 24 * 60 * 60_000;
const TOKEN_MIN_LENGTH = 32;

/**
 * A page that can rewrite credentials is worth a token even on loopback: the token is exchanged once
 * for an HttpOnly cookie, so the link never survives in history, and no cross-site request can carry
 * the cookie (SameSite=Strict). The token file keeps the link stable across restarts.
 */
export class SessionStore {
  private token?: string;
  private readonly sessions = new Map<string, { created: number; seen: number; ip: string }>();
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly absoluteMs: number;

  constructor(private readonly options: { tokenFile: string; idleMs?: number; absoluteMs?: number; now?: () => number }) {
    this.now = options.now ?? (() => Date.now());
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.absoluteMs = options.absoluteMs ?? ABSOLUTE_MS;
  }

  async load(): Promise<string> {
    if (this.token) return this.token;
    try {
      const value = (await readFile(this.options.tokenFile, 'utf8')).trim();
      if (value.length >= TOKEN_MIN_LENGTH) return (this.token = value);
    } catch {
      // Missing or unreadable: mint a new one below.
    }
    return this.rotate();
  }

  async rotate(): Promise<string> {
    const next = randomBytes(32).toString('base64url');
    await mkdir(dirname(this.options.tokenFile), { recursive: true });
    await writeFile(this.options.tokenFile, `${next}\n`, { mode: 0o600 });
    await chmod(this.options.tokenFile, 0o600).catch(() => undefined);
    this.token = next;
    this.sessions.clear();
    return next;
  }

  get current(): string | undefined {
    return this.token;
  }

  async discard(): Promise<void> {
    this.token = undefined;
    this.sessions.clear();
    await unlink(this.options.tokenFile).catch(() => undefined);
  }

  /** Constant-time: a timing side channel here would be a slower way to guess the token. */
  verify(candidate: string | undefined): boolean {
    if (!candidate || !this.token) return false;
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
