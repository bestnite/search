// patchright-core is a patched Playwright: same protocol and API, with the CDP leaks closed.
// Both sides of the connection must share a major.minor, so the browser image pins the same version.
import { chromium, type Browser, type Page } from 'patchright-core';
import { existsSync } from 'node:fs';
import { SearchError } from './transport.js';

/**
 * One connection to the browser the user runs. The browser belongs to them: this class never
 * launches anything, never installs anything and never touches the profile — it attaches, reuses
 * the page that is already there, and evaluates scripts inside it.
 */
export interface BrowserSessionOptions {
  /** Playwright server endpoint, for example ws://127.0.0.1:3000/xhs. */
  wsEndpoint: string;
  /** Bearer token checked by the proxy in front of that endpoint. */
  token?: string;
  /** Page the browser is asked to open when it is not on the site yet. */
  siteUrl: string;
  timeoutMs: number;
  /**
   * Where the signed-in session is kept. The login itself happens in that browser over VNC; this
   * file only lets a fresh connection start already signed in.
   */
  statePath?: string;
}

const SITE_HOST = 'xiaohongshu.com';

export class BrowserSession {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private savedAt = 0;
  private context: Awaited<ReturnType<Browser['newContext']>> | undefined;

  constructor(private readonly options: BrowserSessionOptions) {}

  private async connect(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    try {
      this.browser = await chromium.connect(this.options.wsEndpoint, {
        timeout: this.options.timeoutMs,
        ...(this.options.token ? { headers: { authorization: `Bearer ${this.options.token}` } } : {}),
      });
      return this.browser;
    } catch (error) {
      throw connectFailure(error, this.options);
    }
  }

  /** Reuse the page the browser already has; open one only when it has none. */
  async target(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.ensureOnSite(this.page);
    const browser = await this.connect();
    // Contexts belong to the client that created them, so this process owns the only one: it is
    // also the window the VNC viewer sees. A saved session is loaded here, if one exists.
    const statePath = this.options.statePath;
    const saved = statePath && existsSync(statePath) ? statePath : undefined;
    const context = browser.contexts().find(candidate => candidate.pages().every(page => !page.isClosed()))
      // viewport: null keeps the browser window at its real size instead of emulating one, which is
      // what makes the window visible on the container's display for the one-time sign-in.
      ?? await browser.newContext({ locale: 'zh-CN', viewport: null, ...(saved ? { storageState: saved } : {}) });
    const existing = context.pages().find(page => !page.isClosed());
    this.page = existing ?? await context.newPage();
    this.context = context;
    const ready = await this.ensureOnSite(this.page);
    // Launching a browser server suppresses Chrome's startup window, so the tab has to ask for the
    // window: without this the page runs, but the display the VNC viewer looks at stays empty.
    await ready.bringToFront().catch(() => undefined);
    return ready;
  }

  private async ensureOnSite(page: Page): Promise<Page> {
    if (page.url().includes(SITE_HOST)) return page;
    try {
      await page.goto(this.options.siteUrl, { waitUntil: 'domcontentloaded', timeout: this.options.timeoutMs });
    } catch (error) {
      throw new SearchError('network', `Could not open ${this.options.siteUrl} in the browser: ${message(error)}`);
    }
    return page;
  }

  async evaluate<T>(script: string): Promise<T> {
    const page = await this.target();
    try {
      // Playwright treats a string argument as an expression and never calls it, so the generated
      // source becomes a function here and is serialised to the page like any other page function.
      const pageFunction = new Function(`return (${script});`)() as () => Promise<T>;
      // The site's own client lives in the main world, so this call opts out of patchright's
      // isolated-context default; isolation would hide the very runtime we need to reach.
      return await page.evaluate(pageFunction, undefined, {}, false) as T;
    } catch (error) {
      throw new SearchError('protocol', `The Xiaohongshu page refused to run the read: ${message(error)}`);
    }
  }

  /**
   * Persist the session so the next process starts signed in. Writing on every read would be
   * wasteful, so it happens at most once a minute and only after a call actually succeeded.
   */
  async persist(): Promise<void> {
    const statePath = this.options.statePath;
    if (!statePath || !this.context) return;
    if (Date.now() - this.savedAt < 60_000) return;
    this.savedAt = Date.now();
    await this.context.storageState({ path: statePath }).catch(() => undefined);
  }

  async close(): Promise<void> {
    // Only the connection is dropped; the user's browser keeps running with whatever page state it had.
    await this.persist();
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.page = undefined;
    this.context = undefined;
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A refused endpoint, a missing one and a version mismatch each need a different fix. */
export function connectFailure(error: unknown, options: BrowserSessionOptions): SearchError {
  const text = message(error);
  if (/version mismatch/i.test(text) || /\b428\b/.test(text)) {
    return new SearchError('protocol', `The Playwright server and this client disagree on protocol version, so no request was sent. Update whichever side is older; both must share the same major.minor. (${text.slice(0, 200)})`);
  }
  if (/\b401\b|unauthori[sz]ed/i.test(text)) {
    return new SearchError('authentication', `The Playwright endpoint at ${options.wsEndpoint} rejected the token. Check the token the server printed at startup.`);
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/i.test(text)) {
    return new SearchError('network', `No Playwright server answered at ${options.wsEndpoint}. Start the browser container, or fix the endpoint address.`);
  }
  return new SearchError('network', `Could not attach to the Playwright endpoint at ${options.wsEndpoint}: ${text.slice(0, 200)}`);
}

/** Sessions are shared by endpoint: one connection, many readers, one page per site. */
const sessions = new Map<string, BrowserSession>();

/** The session for an endpoint, created on first use and reused for the life of the process. */
export function sessionFor(key: string, options: BrowserSessionOptions): BrowserSession {
  let session = sessions.get(key);
  if (!session) {
    session = new BrowserSession(options);
    sessions.set(key, session);
  }
  return session;
}

/** Close every kept session; the host calls this when it shuts down. */
export async function closeBrowserSessions(): Promise<void> {
  const open = [...sessions.values()];
  sessions.clear();
  await Promise.all(open.map(session => session.close().catch(() => undefined)));
}
