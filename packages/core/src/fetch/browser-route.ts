import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'patchright-core';
import { delegatedNote } from './notes.js';
import { connectFailure } from '../browser.js';
import type { SearchError } from '../transport.js';
import type { FetchBrowserContextMode, FetchFormat } from './types.js';
import { routeFailure, routeOk, type RouteResult } from './acquisition.js';
import { parseHtmlDocument } from './html.js';
import { utf8ByteLength } from './bytes.js';

/**
 * The browser route.
 *
 * It reuses the browser this project already supports — a Playwright-compatible server at the shared
 * endpoint, guarded by the same token — but it does not touch `BrowserSession`: that session owns the
 * page and the serialization a site reader needs. A page fetch attaches its own client, opens a
 * dedicated context, navigates, captures the main document, and closes everything it created.
 *
 * Teardown has to survive a race: an abort can land while `connect`, `newContext` or `newPage` is
 * still in flight, so a resource that arrives after teardown started is closed on arrival instead of
 * being stored for a teardown that already finished.
 *
 * The remote browser resolves the target outside this process, so the local address policy cannot
 * prove where it lands. Enabling the route is that decision, and every result it produces carries
 * {@link delegatedNote} so a caller is told exactly what could not be checked here.
 */
export interface BrowserRouteRequest {
  url: URL;
  format: FetchFormat;
  routeTimeoutMs: number;
  settleMs: number;
  selectorWait: string;
  contextMode: FetchBrowserContextMode;
  endpoint: string;
  token?: string;
  statePath?: string;
  signal: AbortSignal;
  /**
   * Acquisition bound in UTF-8 bytes for the captured DOM. The remote browser builds its own string
   * but measures it there: a document over the bound reports its byte size only, so it is never
   * serialized across the connection, parsed or converted here.
   */
  maxBodyBytes: number;
}

export type BrowserFetcher = (request: BrowserRouteRequest) => Promise<RouteResult>;

/** The one transport operation this route needs, so tests can drive the real code with a fake browser. */
export type BrowserConnect = (endpoint: string, options: { timeout: number; headers?: Record<string, string> }) => Promise<Browser>;

export const defaultBrowserConnect: BrowserConnect = (endpoint, options) => chromium.connect(endpoint, options);

/** One bounded close, so no single unresponsive resource can hold the whole teardown open. */
const boundedClose = async (operation: () => Promise<unknown>, timeoutMs = 2_000): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([operation().then(() => undefined, () => undefined), timeout]);
  if (timer !== undefined) clearTimeout(timer);
};

/** Wait for `ms` but stop early when the caller aborts. */
const abortableWait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('The browser wait was cancelled.'));
      return;
    }
    const stop = (): void => {
      clearTimeout(timer);
      reject(new Error('The browser wait was cancelled.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener('abort', stop, { once: true });
  });

const failureKind = (error: SearchError): 'authentication' | 'network' | 'protocol' =>
  error.kind === 'authentication' ? 'authentication' : error.kind === 'network' ? 'network' : 'protocol';

/**
 * The driver's own failure code, as a short parenthesised suffix for a message: `net::ERR_*`, an
 * `ERR_*` symbol or an `NS_ERROR_*` one. Anything else — a URL, a redirect target, a body excerpt — is
 * dropped, so a diagnostic can never carry what the target answered.
 */
function diagnosticCode(message: string): string {
  const code = /\b((?:net::)?ERR_[A-Z0-9_]+|NS_ERROR_[A-Z0-9_]+)\b/.exec(message);
  if (code) return ` (${code[1]})`;
  // No driver code means the failure came from something else the driver wrapped — a proxy, a closed
  // socket, a protocol answer. Keep one short line of the driver's own wording, stripped of URLs and
  // anything after a newline, so a cause can still be read without carrying what the target returned.
  const line = (message.split(/\r?\n/)[0] ?? '')
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  return line ? ` (${line})` : '';
}

/** What a page has to look like before a refused status is worth asking about again. */
function looksLikeRealPage(html: string): boolean {
  const parsed = parseHtmlDocument(html, 'about:blank');
  if (!parsed.title) return false;
  return parsed.text.trim().length >= 200;
}

/**
 * Read the rendered document once, measuring UTF-8 bytes inside the page so an oversized document is
 * never serialized across the wire just to be rejected here.
 *
 * A page that navigates itself right after `domcontentloaded` destroys the context the read was bound
 * to. That is not a fetch failure: wait for the replacement document once and read again.
 */
async function readDocument(page: Page, limit: number): Promise<Capture> {
  const read = () => page.evaluate((max: number): Capture => {
    const root = document.documentElement;
    const html = root ? root.outerHTML : '';
    // Four bytes per character is the UTF-8 upper bound; one byte per character is the lower.
    if (html.length * 4 <= max) return { html };
    const bytes = new TextEncoder().encode(html).byteLength;
    return bytes > max ? { tooLarge: bytes } : { html };
  }, limit);
  try {
    return await read();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!/execution context was destroyed|cannot find context|target (page, context or browser )?closed|context was destroyed/i.test(text)) throw error;
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
    return read();
  }
}

/** A captured main document, or the size that made it unacceptable. */
interface Capture {
  html?: string;
  tooLarge?: number;
}

/**
 * Build the browser transport around one connect operation. Production passes the real driver; tests
 * pass a fake browser and assert the same teardown and context policy the real one gets.
 */
export function createBrowserFetcher(connect: BrowserConnect = defaultBrowserConnect): BrowserFetcher {
  return async request => {
    const notes = [delegatedNote('browser')];
    const maxDomBytes = Math.max(1, request.maxBodyBytes);
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    // Which step failed decides how the failure is reported. Message sniffing cannot: a navigation
    // error such as net::ERR_TUNNEL_CONNECTION_FAILED contains the word "connection" without the
    // browser ever failing to attach.
    let stage: 'attach' | 'navigate' = 'attach';
    // What the main document already answered, kept outside the try so a failure after the response
    // can still report the status and the URL instead of discarding them.
    let observedStatus: number | undefined;
    let observedUrl: string | undefined;
    let stopped = false;
    // Close operations started for a resource that arrived after teardown began; awaited before the
    // fetch settles so a late connection cannot outlive the call that made it.
    const stragglers = new Set<Promise<void>>();
    let releasing: Promise<void> | undefined;

    const closeLate = (operation: () => Promise<unknown>): void => {
      const closing = boundedClose(operation);
      stragglers.add(closing);
      void closing.finally(() => stragglers.delete(closing));
    };

    /**
     * Accept a resource only if teardown has not started. Otherwise close it immediately and abort:
     * the caller is already gone, and the promise that produced it may resolve long after that.
     */
    const adopt = <T>(resource: T, close: (value: T) => Promise<unknown>): T => {
      if (stopped) {
        closeLate(() => close(resource));
        throw new Error('The page fetch was cancelled while a resource was arriving.');
      }
      return resource;
    };

    /** Race one awaited step against cancellation so an abort never waits for a slow driver call. */
    const untilAborted = <T>(value: Promise<T>, onLate?: (result: T) => void): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        let settled = false;
        const stop = (): void => {
          if (settled) return;
          settled = true;
          if (onLate) value.then(onLate, () => undefined);
          reject(new Error('The page fetch was cancelled.'));
        };
        if (request.signal.aborted) {
          stop();
          return;
        }
        request.signal.addEventListener('abort', stop, { once: true });
        value.then(
          result => {
            request.signal.removeEventListener('abort', stop);
            if (settled) return;
            settled = true;
            resolve(result);
          },
          error => {
            request.signal.removeEventListener('abort', stop);
            if (settled) return;
            settled = true;
            reject(error);
          },
        );
      });

    /**
     * Single-flight teardown that keeps looking until nothing is left: a resource assigned while a
     * close was awaiting is caught by the next pass, and an abort during `connect` cannot memoize an
     * empty teardown and then let the connection survive.
     */
    const release = (): Promise<void> => {
      releasing ??= (async () => {
        stopped = true;
        for (;;) {
          const targetPage = page;
          const targetContext = context;
          const targetBrowser = browser;
          page = undefined;
          context = undefined;
          browser = undefined;
          if (!targetPage && !targetContext && !targetBrowser && stragglers.size === 0) return;
          if (targetPage) await boundedClose(() => targetPage.close());
          if (targetContext) await boundedClose(() => targetContext.close());
          if (targetBrowser) await boundedClose(() => targetBrowser.close());
          const pending = [...stragglers];
          if (pending.length) await Promise.all(pending);
          if (!page && !context && !browser && stragglers.size === 0) return;
        }
      })();
      return releasing;
    };

    const onAbort = (): void => {
      // Driver calls cannot be interrupted mid-flight; closing what this fetch created unblocks them.
      void release();
    };
    request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const connectOptions = {
        timeout: Math.min(request.routeTimeoutMs, 15_000),
        ...(request.token ? { headers: { authorization: `Bearer ${request.token}` } } : {}),
      };
      // The connect promise outlives the race on purpose: if it resolves after the abort, the late
      // browser is closed instead of being dropped on the floor.
      const connecting = connect(request.endpoint, connectOptions);
      const connected = await untilAborted(connecting, late => {
        if (stopped) closeLate(() => late.close());
      });
      browser = adopt(connected, value => value.close());
      if (request.signal.aborted) throw new Error('The page fetch was cancelled.');
      // Everything from here on runs inside an attached browser.
      stage = 'navigate';
      const statePath = request.contextMode === 'session' ? request.statePath : undefined;
      const usableState = statePath && existsSync(statePath) ? statePath : undefined;
      if (request.contextMode === 'session' && !usableState) notes.push('Session context requested but no saved state file exists; the fetch ran with an empty context.');
      const creatingContext = browser.newContext({
        locale: 'en-US',
        viewport: { width: 1280, height: 800 },
        ...(usableState ? { storageState: usableState } : {}),
      });
      const createdContext = await untilAborted(creatingContext, late => {
        if (stopped) closeLate(() => late.close());
      });
      context = adopt(createdContext, value => value.close());
      if (request.signal.aborted) throw new Error('The page fetch was cancelled.');
      const openingPage = context.newPage();
      const openedPage = await untilAborted(openingPage, late => {
        if (stopped) closeLate(() => late.close());
      });
      page = adopt(openedPage, value => value.close());

      let response = await untilAborted(page.goto(request.url.href, { waitUntil: 'domcontentloaded', timeout: request.routeTimeoutMs }));
      if (request.selectorWait) {
        try {
          await page.waitForSelector(request.selectorWait, { timeout: Math.min(request.routeTimeoutMs, 10_000) });
        } catch {
          notes.push('The configured selector did not appear before the wait ended; the captured DOM may be incomplete.');
        }
      }
      if (request.settleMs > 0) await abortableWait(request.settleMs, request.signal);
      let statusCode = response?.status();
      // Record what the first navigation already answered, so a failure while reading can still
      // report the status and URL instead of losing them.
      observedStatus = statusCode;
      observedUrl = page.url();
      // Some anti-bot fronts answer the first document with a 4xx while handing the browser the
      // cookie that unlocks the next one; Zhihu does exactly this, and the first document it returns
      // still renders the real page. Asking once more with that cookie turns a refused load into a
      // 200. The retry only happens when the first document is a real page, never for a bare 4xx.
      if (statusCode !== undefined && statusCode >= 400) {
        const firstDocument = await readDocument(page, maxDomBytes);
        if (!('html' in firstDocument) || !looksLikeRealPage(firstDocument.html ?? '')) {
          // Not a rendered page: keep the refusal as the outcome instead of asking again.
        } else {
          notes.push(`The first document answered HTTP ${statusCode}; it rendered a page, so the navigation was retried once with the cookies that answer set.`);
          try {
            response = await untilAborted(page.goto(request.url.href, { waitUntil: 'domcontentloaded', timeout: request.routeTimeoutMs }));
            statusCode = response?.status();
          } catch {
            // The retry failing keeps the first status and the document already read below.
          }
        }
      }
      const finalUrl = page.url();
      observedStatus = statusCode;
      observedUrl = finalUrl;
      // Bound the capture inside the page: the remote side measures UTF-8 bytes and, when the
      // document is over the bound, reports only the size instead of serializing it across the wire.
      const target = page;
      const captured = await untilAborted(readDocument(target, maxDomBytes));
      if (typeof captured.tooLarge === 'number') {
        return routeFailure(
          'limit',
          { kind: 'limit', message: `The rendered document exceeded the ${maxDomBytes}-byte acquisition limit.` },
          { fatal: true, ...(statusCode === undefined ? {} : { statusCode }), finalUrl, notes },
        );
      }
      const html = captured.html ?? '';
      // Defense in depth: a page context without the measuring helper, or an older remote page, can
      // still return an oversized body, and the byte bound applies before any parsing happens.
      if (utf8ByteLength(html) > maxDomBytes) {
        return routeFailure(
          'limit',
          { kind: 'limit', message: `The rendered document exceeded the ${maxDomBytes}-byte acquisition limit.` },
          { fatal: true, ...(statusCode === undefined ? {} : { statusCode }), finalUrl, notes },
        );
      }
      const parsed = parseHtmlDocument(html, finalUrl);
      const isError = statusCode !== undefined && statusCode >= 400;
      return {
        outcome: isError ? 'http-error' : 'ok',
        notes,
        finalUrl,
        ...(statusCode === undefined ? {} : { statusCode }),
        representation: 'rendered-dom',
        html,
        cleanHtml: parsed.cleanedHtml,
        text: parsed.text,
        ...(parsed.title ? { title: parsed.title } : {}),
        ...(isError ? { error: { kind: 'http' as const, message: `The target answered HTTP ${statusCode}.`, status: statusCode } } : {}),
      };
    } catch (error) {
      if (request.signal.aborted) {
        return routeFailure('cancelled', { kind: 'network', message: 'The page fetch was cancelled.' }, { fatal: true, notes });
      }
      // A failure while attaching is classified once, by the code that already knows the endpoint.
      const attach = stage === 'attach'
        ? connectFailure(error, { wsEndpoint: request.endpoint, timeoutMs: request.routeTimeoutMs, siteUrl: 'about:blank' })
        : undefined;
      if (attach) return routeFailure(failureKind(attach), { kind: failureKind(attach), message: attach.message }, { notes });
      const message = error instanceof Error ? error.message : String(error);
      const observed = observedStatus === undefined
        ? ''
        : ` The target answered HTTP ${observedStatus} before the read failed.`;
      const kept = { notes, ...(observedStatus === undefined ? {} : { statusCode: observedStatus }), ...(observedUrl === undefined ? {} : { finalUrl: observedUrl }) };
      if (/timeout/i.test(message)) {
        return routeFailure('timeout', { kind: 'timeout', message: `The browser did not finish loading the page within the route timeout.${observed}` }, kept);
      }
      // A navigation failure is useless without its cause: "could not load the page" covers a wrong
      // proxy, a refused connection, a redirect loop and a certificate problem alike. Keep the
      // driver's own code (net::ERR_*), never the URL or anything the target sent back.
      return routeFailure('network', { kind: 'network', message: `The browser could not load the target page${diagnosticCode(message)}.${observed}` }, kept);
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      await release();
      // A late resource can arrive between the release check and this line; settle it before returning.
      while (stragglers.size) await Promise.all([...stragglers]);
    }
  };
}

export const fetchWithBrowser: BrowserFetcher = createBrowserFetcher();

export { routeOk };
