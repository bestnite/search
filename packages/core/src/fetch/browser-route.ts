import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'patchright-core';
import { delegatedNote } from './notes.js';
import { connectFailure, defaultBrowserStatePath } from '../browser.js';
import type { SearchError } from '../transport.js';
import type { FetchBrowserContextMode, FetchChallengeSolver, FetchFormat } from './types.js';
import {
  CHALLENGE_HTML_MARKERS,
  CHALLENGE_SCAN_CHARS,
  challengeHtmlMatches,
  challengeNote,
  detectCloudflareChallenge,
  isChallengeFrameUrl,
  otherInterstitialName,
  type ChallengeDetection,
} from './challenge.js';
import { CHALLENGE_CLICK_INTERVAL_MS, CHALLENGE_MAX_CLICKS, CHALLENGE_POLL_INTERVAL_MS, CHALLENGE_RENDER_WINDOW_MS, CHALLENGE_SOLVE_WINDOW_MS, MAX_FETCH_NAVIGATIONS, READABLE_TEXT_MIN_CHARS, RENDER_WINDOW_MS } from './limits.js';
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
  /** `off` disables the challenge attempt entirely; `auto` spends one bounded attempt. */
  challengeSolver: FetchChallengeSolver;
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
    // Ref'd on purpose: while a challenge is being polled this wait is the only pending work, and an
    // unref'd timer lets the process decide the loop is empty and drop the fetch instead of timing out.
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
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

/**
 * The document title, as far as challenge identification needs it.
 *
 * A bounded read of the head is enough here: the authoritative title of the returned result still
 * comes from the one full parse at the end, and this one only feeds the marker check. Parsing a large
 * document twice just to compare a title would be work the fetch does not need to do.
 */
function titleFromHtml(html: string): string {
  const match = /<title[^>]*>([\s\S]{0,512}?)<\/title>/i.exec(html.slice(0, 65_536));
  return (match?.[1] ?? '').replace(/\s+/g, ' ').trim();
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

/** One judged document: the capture that becomes the result, and the challenge identification. */
interface Judged {
  capture: Capture;
  detection?: ChallengeDetection;
}

/** How one automatic challenge attempt ended. Only `cleared` earns a retried navigation. */
type SolveOutcome = { status: 'cleared' | 'frame-missing' | 'click-failed' | 'timeout' | 'looped'; clicks: number };

/**
 * The one element worth pressing. The Turnstile widget renders a loading state first and only then
 * adds its checkbox; pressing a wrapper or the frame body during that window hits empty space and still
 * looks like a successful click, which is worse than no click at all. Nothing else is clicked.
 */
const CHALLENGE_CHECKBOX_SELECTOR = 'input[type=checkbox]';

/** How long a single pass waits for that checkbox to appear before giving the widget another chance. */
const CLICK_WAIT_MS = 6_000;

/** Frames the driver knows about. A page's own script cannot list a cross-origin frame. */
const knownFrames = (page: Page): Frame[] => {
  try {
    return page.frames?.() ?? [];
  } catch {
    return [];
  }
};

const frameUrl = (frame: Frame): string => {
  try {
    return frame.url();
  } catch {
    return '';
  }
};

/** The frame URLs of one page, for challenge identification. */
const frameUrlsOf = (page: Page): string[] => knownFrames(page).map(frameUrl);

/** The Turnstile widget's own frame, when the page has one attached. */
const challengeFrame = (page: Page): Frame | undefined => knownFrames(page).find(frame => isChallengeFrameUrl(frameUrl(frame)));

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
      // An empty path in session mode is not "no session": it means the standard file the browser
      // container writes. A configured path always wins.
      const statePath = request.contextMode === 'session' ? (request.statePath || defaultBrowserStatePath()) : undefined;
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

      // Everything below judges one page handle. Teardown may clear `page` at any moment, so this
      // local keeps every call bound to the page this fetch created.
      const activePage = page;
      let response = await untilAborted(activePage.goto(request.url.href, { waitUntil: 'domcontentloaded', timeout: request.routeTimeoutMs }));
      if (request.selectorWait) {
        try {
          await activePage.waitForSelector(request.selectorWait, { timeout: Math.min(request.routeTimeoutMs, 10_000) });
        } catch {
          notes.push('The configured selector did not appear before the wait ended; the captured DOM may be incomplete.');
        }
      }
      if (request.settleMs > 0) await abortableWait(request.settleMs, request.signal);
      let statusCode = response?.status();
      // Record what the first navigation already answered, so a failure while reading can still
      // report the status and URL instead of losing them.
      observedStatus = statusCode;
      observedUrl = activePage.url();
      // Every automatic navigation is counted here, so the anti-bot retry and the challenge attempt
      // share one cap instead of each spending its own.
      let navigations = 1;

      const limitResult = (): RouteResult =>
        routeFailure(
          'limit',
          { kind: 'limit', message: `The rendered document exceeded the ${maxDomBytes}-byte acquisition limit.` },
          { fatal: true, ...(statusCode === undefined ? {} : { statusCode }), finalUrl: activePage.url(), notes },
        );

      /**
       * Read and judge the document the page holds now: one capture, reused as the result, and the
       * challenge identification over that same capture.
       */
      /**
       * A number that changes when the page is replaced by a new navigation and stays the same within
       * one document. Reading it is how the route tells "the page is still working" from "the page threw
       * the challenge away and started over".
       */
      const documentIdentity = async (page: Page): Promise<number | undefined> => {
        try {
          const value = await untilAborted(page.evaluate(() => performance.timeOrigin));
          return typeof value === 'number' ? value : undefined;
        } catch (error) {
          if (request.signal.aborted) throw error;
          return undefined;
        }
      };

      /**
       * Wait, within a bounded window, until the document holds text a reader could see. Returns false
       * when the window closed with the page still looking like a shell, so the caller can say so
       * instead of silently returning nothing.
       */
      const waitForReadableText = async (page: Page, budgetMs: number): Promise<boolean> => {
        if (!page.waitForFunction) return true;
        try {
          // The page itself reports readiness: `raf` polling runs in the document, so the wait ends on
          // the frame the text appears instead of on the next crossing to this process.
          await untilAborted(page.waitForFunction(
            (minimum: number) => (document.body?.innerText ?? '').trim().length >= minimum,
            READABLE_TEXT_MIN_CHARS,
            { timeout: Math.max(0, budgetMs), polling: 'raf' },
          ));
          return true;
        } catch (error) {
          if (request.signal.aborted) throw error;
          return false;
        }
      };

      const judge = async (): Promise<Judged> => {
        const capture = await untilAborted(readDocument(activePage, maxDomBytes));
        if (typeof capture.tooLarge === 'number') return { capture };
        const html = capture.html ?? '';
        const detection = detectCloudflareChallenge({
          title: titleFromHtml(html),
          htmlMatches: challengeHtmlMatches(html),
          frameUrls: frameUrlsOf(activePage),
          ...(statusCode === undefined ? {} : { statusCode }),
        });
        return { capture, detection };
      };

      /**
       * One more navigation for a document worth asking about again. False when the cap is reached or
       * the driver refused the load, in which case the previous status and document stay in place.
       */
      const navigateAgain = async (): Promise<boolean> => {
        if (navigations >= MAX_FETCH_NAVIGATIONS) return false;
        navigations += 1;
        try {
          const answer = await untilAborted(activePage.goto(request.url.href, { waitUntil: 'domcontentloaded', timeout: request.routeTimeoutMs }));
          statusCode = answer?.status();
        } catch (error) {
          // A failed retry keeps the status and the document already read; an abort is not a retry.
          if (request.signal.aborted) throw error;
          return false;
        }
        return true;
      };

      /**
       * Identify a challenge from the live document without serializing it: the needle scan runs
       * inside the page, so polling costs one small round trip instead of the whole DOM.
       */
      const liveChallenge = async (): Promise<ChallengeDetection | 'unknown'> => {
        // A challenge page reloads itself; the probe can land exactly in that gap and lose its context.
        // That is "still challenging", never a fetch failure, so it is read as one here.
        let answer: { title: string; htmlMatches: string[] } | undefined;
        try {
          answer = await untilAborted(activePage.evaluate((options: { needles: readonly string[]; scan: number }) => {
            const root = document.documentElement;
            const html = (root ? root.outerHTML : '').slice(0, options.scan).toLowerCase();
            return { title: document.title, htmlMatches: options.needles.filter(needle => html.includes(needle)) };
          }, { needles: CHALLENGE_HTML_MARKERS, scan: CHALLENGE_SCAN_CHARS }));
        } catch (error) {
          if (request.signal.aborted) throw error;
          // Unknown is not cleared: a page that replaced its document mid-probe must keep the loop
          // going, or a reload would be mistaken for a solved challenge.
          return 'unknown';
        }
        return detectCloudflareChallenge({
          ...(answer ? { title: answer.title, htmlMatches: answer.htmlMatches } : {}),
          frameUrls: frameUrlsOf(activePage),
          ...(statusCode === undefined ? {} : { statusCode }),
        });
      };

      /** Click the widget through one frame handle, trying the shapes in order. */
      /**
       * Press the checkbox itself, and only that. The widget shows a loading state first, and pressing a
       * fallback shape while it loads put the click on empty space and then counted the attempt as done —
       * which is how a real widget was observed to be pressed "three times" without ever being pressed.
       */
      const clickChallengeWidget = async (frame: Frame, timeoutMs: number): Promise<boolean> => {
        const box = frame.locator(CHALLENGE_CHECKBOX_SELECTOR).first();
        try {
          if (await untilAborted(box.count()) === 0) return false;
          const bounds = await untilAborted(box.boundingBox());
          if (!bounds || bounds.width < 10 || bounds.height < 8) return false;
          // Move to the target first, then press. A managed challenge scores the pointer trail it sees,
          // and a click that appears from nowhere in an otherwise untouched page is what it expects from
          // an automation client; a short move into the widget is the cheapest honest improvement.
          if (typeof box.hover === 'function') {
            await untilAborted(box.hover({ timeout: timeoutMs })).catch(() => undefined);
            await abortableWait(120, request.signal);
          }
          await untilAborted(box.click({ timeout: timeoutMs }));
          return true;
        } catch (error) {
          if (request.signal.aborted) throw error;
          return false;
        }
      };

      /**
       * One bounded attempt to clear a Turnstile challenge, run entirely by the driver.
       *
       * The widget lives in a cross-origin frame, so no page script can reach it; the driver holds a
       * handle for that frame and clicks inside it. Success is decided only by the markers vanishing
       * from the main document — a click that "worked" but left the interstitial in place is a
       * failure, never a success.
       */
      /**
       * Wait until the checkbox exists and has a size to hit. The widget renders a loading state before
       * the checkbox appears, and clicking anything during that window is a click on nothing.
       */
      const waitForChallengeCheckbox = async (frame: Frame, budgetMs: number): Promise<boolean> => {
        const deadlineAt = Date.now() + Math.max(0, budgetMs);
        for (;;) {
          try {
            const box = frame.locator(CHALLENGE_CHECKBOX_SELECTOR).first();
            if (await untilAborted(box.count()) > 0) {
              const bounds = await untilAborted(box.boundingBox());
              if (bounds && bounds.width >= 10 && bounds.height >= 8) return true;
            }
          } catch (error) {
            if (request.signal.aborted) throw error;
          }
          if (Date.now() >= deadlineAt) return false;
          await abortableWait(Math.min(250, Math.max(0, deadlineAt - Date.now())), request.signal);
        }
      };

      /**
       * After the widget clears, the page finishes on its own. No reload is forced here: a passed
       * Turnstile reloads into the real document by itself, and one that did not pass is not going to
       * pass because we asked again. This waits, within the render window, until the document holds
       * readable text, and reports whether that happened.
       */
      const finishClearedChallenge = async (): Promise<boolean> => {
        const budget = Math.min(CHALLENGE_RENDER_WINDOW_MS, request.routeTimeoutMs);
        const deadlineAt = Date.now() + budget;
        for (;;) {
          const live = await liveChallenge();
          if (live !== 'unknown' && !live.challenge) {
            const text = await activePage.evaluate(() => (document.body?.innerText ?? '').trim().length).catch(error => {
              if (request.signal.aborted) throw error;
              return 0;
            });
            if (text >= READABLE_TEXT_MIN_CHARS) {
              // The document that replaced the challenge was loaded by the page itself. Its status is
              // readable from the navigation timing entry, so the real answer is reported without a
              // reload of our own.
              const fresh = await activePage.evaluate(() => {
                const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
                return entry?.responseStatus ?? 0;
              }).catch(error => {
                if (request.signal.aborted) throw error;
                return 0;
              });
              if (typeof fresh === 'number' && fresh >= 100) {
                statusCode = fresh;
                observedStatus = fresh;
              } else {
                // Nothing to read the resolved document's status from. The content is the evidence:
                // report the status as unknown rather than carrying the refusal the challenge answered.
                statusCode = undefined;
                notes.push("The resolved document's status could not be read; the captured content is what the result rests on.");
              }
              notes.push('The challenge page finished on its own after the widget cleared; no reload was made.');
              return true;
            }
          }
          if (Date.now() >= deadlineAt) return false;
          await abortableWait(Math.min(250, Math.max(0, deadlineAt - Date.now())), request.signal);
        }
      };

      const solveChallenge = async (): Promise<SolveOutcome> => {
        // The window is clipped by the route timeout, and the route signal already carries the
        // caller, the route timeout and the overall deadline, so every wait here is both bounded and
        // cancellable. Nothing in this loop waits for a person.
        const windowMs = Math.max(CHALLENGE_POLL_INTERVAL_MS, Math.min(CHALLENGE_SOLVE_WINDOW_MS, request.routeTimeoutMs));
        let deadline = Date.now() + windowMs;
        let frameSeen = false;
        let clicks = 0;
        let nextClickAt = 0;
        // Identity of the document the press happened in. A challenge that answers a press with a fresh
        // challenge page reloads itself; pressing again only repeats the cycle, and the loop is
        // detectable from the fact that the document was replaced while the challenge stayed.
        let pressedDocument: number | undefined;
        while (Date.now() < deadline) {
          const frame = challengeFrame(activePage);
          if (frame) {
            frameSeen = true;
            // The widget is in the document before it is laid out: at load it measures 0x0 and a click
            // there lands on the page behind it, which looks like nothing happened. Only click a
            // widget the browser has actually sized, and keep clicking while the challenge stands —
            // a single early click used to be the whole attempt.
            const ready = await waitForChallengeCheckbox(frame, Math.min(CLICK_WAIT_MS, Math.max(500, deadline - Date.now())));
            if (ready && clicks < CHALLENGE_MAX_CLICKS && Date.now() >= nextClickAt) {
              // Record the document the press happens in, before the press: the reload it may trigger
              // replaces the document immediately.
            const beforePress = await documentIdentity(activePage);
              if (await clickChallengeWidget(frame, Math.min(2_000, Math.max(500, deadline - Date.now())))) {
                clicks += 1;
                pressedDocument = beforePress;
                nextClickAt = Date.now() + CHALLENGE_CLICK_INTERVAL_MS;
                // A pressed widget needs longer than the plain solve window: the platform verifies, sets
                // its clearance cookie and reloads the page, and a forum behind it boots afterwards.
                // The route signal still ends this at the route deadline, so the extra time is bounded.
                deadline = Math.max(deadline, Date.now() + Math.min(CHALLENGE_RENDER_WINDOW_MS, request.routeTimeoutMs));
              }
            }
          }
          if (clicks > 0) {
            const live = await liveChallenge();
            if (live !== 'unknown' && !live.challenge) return { status: 'cleared', clicks };
            // The page the press happened in was replaced, and the replacement is still a challenge:
            // this is the self-reloading loop, not a page that is about to render.
            const now = await documentIdentity(activePage);
            if (live !== 'unknown' && now !== undefined && pressedDocument !== undefined && now !== pressedDocument) {
              return { status: 'looped', clicks };
            }
          }
          await abortableWait(Math.max(0, Math.min(CHALLENGE_POLL_INTERVAL_MS, deadline - Date.now())), request.signal);
        }
        if (!frameSeen) return { status: 'frame-missing', clicks };
        if (clicks === 0) return { status: 'click-failed', clicks };
        return { status: 'timeout', clicks };
      };

      // An anti-bot answer often returns a bare shell and then hydrates the real document from the
      // same response. Give the page a bounded moment to finish that before judging it.
      if (statusCode !== undefined && statusCode >= 400) {
        await activePage.waitForLoadState?.('load', { timeout: 3_000 }).catch(() => undefined);
        await activePage.waitForFunction?.(() => document.title.trim().length > 0, undefined, { timeout: 3_000 }).catch(() => undefined);
      } else {
        // A client-rendered page is a shell at `domcontentloaded`: Discourse, React and Vue apps put the
        // forum in the DOM a moment later. Waiting for readable text costs nothing on a static page and
        // turns an empty capture into the real one. Bounded by the route budget, never waits for a person.
        if (!(await waitForReadableText(activePage, Math.min(RENDER_WINDOW_MS, request.routeTimeoutMs)))) {
          notes.push('The captured document held almost no readable text after the render window; a client-rendered page may not have finished before the capture.');
        }
      }
      let judged = await judge();
      if (typeof judged.capture.tooLarge === 'number') return limitResult();
      // Honest identification: a shield page and a plain refusal become distinguishable in the record.
      // The note never changes the outcome on its own.
      let challengeNoted = false;
      // Not every interstitial is Cloudflare. The solver is Cloudflare-only, so a stranger's challenge is
      // named and left alone instead of being described as something it is not.
      if (!judged.detection?.challenge && statusCode !== undefined && statusCode >= 400) {
        const other = otherInterstitialName(frameUrlsOf(activePage));
        if (other) notes.push(`A ${other} interstitial answered instead of the page; it is not a Cloudflare challenge, so nothing was attempted.`);
      }
      if (judged.detection?.challenge) {
        notes.push(challengeNote(judged.detection));
        challengeNoted = true;
      }

      // Some anti-bot fronts answer the first document with a 4xx while handing the browser the
      // cookie that unlocks the next one; Zhihu does exactly this, and the first document it returns
      // still renders the real page. Asking once more with that cookie turns a refused load into a
      // 200. The retry only happens when the first document is a real page, never for a bare 4xx.
      // A challenge page is not the "rendered a real page" case: reloading it here resets the challenge
      // the solver is about to attempt, which is exactly what made a passed Turnstile appear again.
      if (statusCode !== undefined && statusCode >= 400 && !judged.detection?.challenge && looksLikeRealPage(judged.capture.html ?? '')) {
        notes.push(`The first document answered HTTP ${statusCode}; it rendered a page, so the navigation was retried once with the cookies that answer set.`);
        if (await navigateAgain()) {
          judged = await judge();
          if (typeof judged.capture.tooLarge === 'number') return limitResult();
          if (judged.detection?.challenge && !challengeNoted) {
            notes.push(challengeNote(judged.detection));
            challengeNoted = true;
          }
        }
      }

      // One bounded automatic attempt, only for an identified challenge and only when the saved
      // setting allows it. The anti-bot retry above is unchanged and still runs: the two share the
      // navigation cap rather than replacing each other.
      if (judged.detection?.challenge) {
        if (request.challengeSolver !== 'auto') {
          notes.push('The Cloudflare challenge solver is off, so the challenge page was left exactly as it answered.');
        } else if (navigations >= MAX_FETCH_NAVIGATIONS) {
          // Defensive: the branch above the solver already stops at the cap, so this guard exists to
          // keep a future change to the cap from spending a navigation the route did not budget for.
          notes.push('The navigation budget was already spent, so the automatic challenge attempt did not run.');
        } else {
          const solved = await solveChallenge();
          if (solved.status === 'looped') {
            notes.push('The challenge page answered the press with a fresh challenge instead of the page, so the attempt stopped: pressing again only repeats that cycle.');
          } else if (solved.status === 'frame-missing') {
            notes.push('No frame pointed at challenges.cloudflare.com, so the automatic challenge attempt sent no click; the challenge was not cleared.');
          } else if (solved.status === 'click-failed') {
            notes.push('The challenge widget never became clickable, so the automatic attempt sent no click; the challenge was not cleared.');
          } else if (solved.status === 'timeout') {
            notes.push(`The automatic Cloudflare challenge attempt pressed the widget ${solved.clicks} time${solved.clicks === 1 ? '' : 's'}, but the challenge was still present when the solve window ended; it was not cleared.`);
          } else if (await finishClearedChallenge()) {
            judged = await judge();
            if (typeof judged.capture.tooLarge === 'number') return limitResult();
            notes.push(judged.detection?.challenge
              ? 'The automatic Cloudflare challenge attempt cleared the widget, but the document still looked like a challenge afterwards.'
              : 'The automatic Cloudflare challenge attempt cleared the widget; the page resolved into the real document.');
          } else {
            notes.push('The automatic Cloudflare challenge attempt cleared the widget, but the document never produced readable content within the render window.');
          }
        }
      }

      const finalUrl = activePage.url();
      observedStatus = statusCode;
      observedUrl = finalUrl;
      const html = judged.capture.html ?? '';
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
