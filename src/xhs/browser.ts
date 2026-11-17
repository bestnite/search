// patchright-core is a patched Playwright: same protocol and API, with the CDP leaks closed.
// Both sides of the connection must share a major.minor, so the browser image pins the same version.
import { chromium, type Browser, type Page } from 'patchright-core';
import { SearchError } from '../transport.js';

/**
 * One connection to the browser the user runs. The browser belongs to them: this class never
 * launches anything, never installs anything and never touches the profile — it attaches, reuses
 * the page that is already there, and evaluates scripts inside it.
 */
export interface BrowserOptions {
  /** Playwright server endpoint, for example ws://127.0.0.1:3000/xhs. */
  wsEndpoint: string;
  /** Bearer token checked by the proxy in front of that endpoint. */
  token?: string;
  /** Page the browser is asked to open when it is not on the site yet. */
  siteUrl: string;
  timeoutMs: number;
}

const SITE_HOST = 'xiaohongshu.com';

export class XhsBrowser {
  private browser: Browser | undefined;
  private page: Page | undefined;

  constructor(private readonly options: BrowserOptions) {}

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
    const context = browser.contexts().find(candidate => candidate.pages().every(page => !page.isClosed())) ?? await browser.newContext({ locale: 'zh-CN' });
    const existing = context.pages().find(page => !page.isClosed());
    this.page = existing ?? await context.newPage();
    return this.ensureOnSite(this.page);
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
      // The site's own client lives in the main world, so this call opts out of patchright's
      // isolated-context default; isolation would hide the very runtime we need to reach.
      return await page.evaluate(script, undefined, {}, false) as T;
    } catch (error) {
      throw new SearchError('protocol', `The Xiaohongshu page refused to run the read: ${message(error)}`);
    }
  }

  async close(): Promise<void> {
    // Only the connection is dropped; the user's browser keeps running with whatever page state it had.
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.page = undefined;
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A refused endpoint, a missing one and a version mismatch each need a different fix. */
export function connectFailure(error: unknown, options: BrowserOptions): SearchError {
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
