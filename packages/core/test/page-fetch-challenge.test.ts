import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, parseConfig, validateConfig } from '../src/config.js';
import { createBrowserFetcher, type BrowserRouteRequest } from '../src/fetch/browser-route.js';
import { challengeHtmlMatches, challengeNote, detectCloudflareChallenge } from '../src/fetch/challenge.js';
import { MAX_FETCH_NAVIGATIONS } from '../src/fetch/limits.js';
import { createPageFetchEngine } from '../src/fetch/engine.js';
import type { SearchConfig } from '../src/types.js';

/**
 * Cloudflare challenge identification and the one bounded automatic attempt.
 *
 * Every test drives the real browser route through a fake browser: no network, no real driver, no
 * site. The fake page runs the route's own in-page functions against a stub `document`, so the byte
 * bound, the title read and the needle probe are the production code paths, not a re-implementation.
 */

const TARGET = 'https://nopecha.com/demo/cloudflare';
const CHALLENGE_FRAME_URL = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1';

const challengeDocument = (title = 'Just a moment...'): FakeDocument => ({
  title,
  html: `<!DOCTYPE html><html><head><title>${title}</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></head>`
    + `<body><div id="challenge-stage"><div class="cf-turnstile"></div><p>${'Checking your browser before accessing the site. '.repeat(8)}</p></div></body></html>`,
});

const realDocument = (title = 'Example Domain'): FakeDocument => ({
  title,
  html: `<!DOCTYPE html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${'This is the page behind the shield. '.repeat(10)}</p></body></html>`,
});

/** The document a fake page holds: what the tiny stub `document` reports to the page functions. */
interface FakeDocument {
  title: string;
  html: string;
}

interface Scenario {
  /** Status and document after each navigation, in order; the last step repeats. */
  steps: { status: number; document: FakeDocument }[];
  /** The document the page holds once the widget was clicked, when clicking changes the page. */
  afterClick?: FakeDocument;
  /** Refuse the click, so no candidate widget can be pressed. */
  refuseClick?: boolean;
  /** Keep the widget at 0x0 for this many geometry reads, the way an un-laid-out widget looks. */
  layoutAfterReads?: number;
  /** Hold the document as a shell for this long after the click, the way a booting app behaves. */
  renderDelayMs?: number;
  /** The status the resolved document answers once the delay elapses; 200 by default. */
  afterClickStatus?: number;
}

interface PageState {
  loads: number;
  clicks: number;
  closed: boolean;
  /** Every element selector the route tried to click, in order. */
  clickedSelectors: string[];
}

interface Fixture {
  fetcher: ReturnType<typeof createBrowserFetcher>;
  page: PageState;
  contextClosed: () => boolean;
  browserClosed: () => boolean;
}

/** Run one page function against a stub document, so the fake exercises the real in-page code. */
function runInPage(fn: (argument: unknown) => unknown, argument: unknown, document: FakeDocument): unknown {
  const holder = globalThis as { document?: unknown };
  const previous = holder.document;
  const visible = document.html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  holder.document = { documentElement: { outerHTML: document.html }, title: document.title, body: { innerText: visible } };
  try {
    return fn(argument);
  } finally {
    if (previous === undefined) delete holder.document;
    else holder.document = previous;
  }
}

function browserFixture(scenario: Scenario): Fixture {
  const page: PageState = { loads: 0, clicks: 0, closed: false, clickedSelectors: [] };
  let step = 0;
  let current = scenario.steps[0]!.document;
  let status = scenario.steps[0]!.status;
  let contextClosed = false;
  let browserClosed = false;

  const challengeShowing = (): boolean => detectCloudflareChallenge({
    title: current.title,
    htmlMatches: challengeHtmlMatches(current.html),
  }).challenge;

  const widget = {
    count: async (): Promise<number> => (scenario.refuseClick ? 0 : 1),
    click: async (): Promise<void> => {
      page.clicks += 1;
      if (!scenario.afterClick) return;
      if (!scenario.renderDelayMs) {
        current = scenario.afterClick;
        return;
      }
      // The click landed; the document stays a shell until the application boots.
      const ready = scenario.afterClick;
      const resolvedStatus = scenario.afterClickStatus ?? 200;
      setTimeout(() => {
        current = ready;
        status = resolvedStatus;
      }, scenario.renderDelayMs);
    },
  };

  const fakePage = {
    goto: async (): Promise<{ status: () => number }> => {
      page.loads += 1;
      const index = Math.min(step, scenario.steps.length - 1);
      step += 1;
      current = scenario.steps[index]!.document;
      status = scenario.steps[index]!.status;
      return { status: () => status };
    },
    url: (): string => TARGET,
    waitForLoadState: async (): Promise<void> => undefined,
    waitForFunction: async (): Promise<void> => undefined,
    evaluate: async (fn: (argument: unknown) => unknown, argument: unknown): Promise<unknown> => {
      if (typeof fn === 'function' && String(fn).includes('getEntriesByType')) return status;
      return runInPage(fn, argument, current);
    },
    close: async (): Promise<void> => {
      page.closed = true;
    },
  };

  // The frame is only ever reached through the driver; the widget records which selector was tried.
  // A widget is in the document before it is laid out: the fixture can hold it at 0x0 for a while, the
  // way a real challenge page does before its stylesheet sizes the frame.
  let layoutReads = 0;
  const frameFor = (selector: string) => ({
    count: widget.count,
    click: async (): Promise<void> => {
      page.clickedSelectors.push(selector);
      await widget.click();
    },
    boundingBox: async (): Promise<{ x: number; y: number; width: number; height: number }> => {
      layoutReads += 1;
      const unlaid = scenario.layoutAfterReads !== undefined && layoutReads <= scenario.layoutAfterReads;
      return unlaid ? { x: 192, y: 304, width: 0, height: 0 } : { x: 192, y: 304, width: 300, height: 65 };
    },
  });
  const frames = () => (challengeShowing()
    ? [{ url: () => CHALLENGE_FRAME_URL, locator: (selector: string) => ({ first: () => frameFor(selector) }) }]
    : []);

  const fetcher = createBrowserFetcher(async () => ({
    newContext: async () => ({
      newPage: async () => ({ ...fakePage, frames }),
      close: async () => {
        contextClosed = true;
      },
    }),
    close: async () => {
      browserClosed = true;
    },
  }) as never);

  return { fetcher, page, contextClosed: () => contextClosed, browserClosed: () => browserClosed };
}

function request(overrides: Partial<BrowserRouteRequest> = {}): BrowserRouteRequest {
  return {
    url: new URL(TARGET),
    format: 'markdown',
    routeTimeoutMs: 5_000,
    settleMs: 0,
    selectorWait: '',
    contextMode: 'isolated',
    challengeSolver: 'auto',
    endpoint: 'ws://127.0.0.1:3030/ws',
    maxBodyBytes: 1_000_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

// --- identification -----------------------------------------------------------------------------

test('a challenge is identified from independent markers, never from the bare word cloudflare', () => {
  const byTitle = detectCloudflareChallenge({ title: 'Just a moment...' });
  assert.equal(byTitle.challenge, true);
  assert.match(byTitle.markers.join(' | '), /the title matched "Just a moment"/);

  const byChineseTitle = detectCloudflareChallenge({ title: '请稍候…' });
  assert.equal(byChineseTitle.challenge, true, 'the Chinese interstitial is identified too');

  const byMarker = detectCloudflareChallenge({ htmlMatches: challengeHtmlMatches('<div class="cf-chl-widget-abc"></div>') });
  assert.equal(byMarker.challenge, true);
  assert.match(byMarker.markers.join(' | '), /the document carried a cf-chl marker/);

  // An embedded Turnstile widget on a healthy page is not a challenge: only a refusal makes the
  // platform's own files count as evidence.
  const frameOnly = detectCloudflareChallenge({ frameUrls: [CHALLENGE_FRAME_URL], statusCode: 200 });
  assert.equal(frameOnly.challenge, false, 'a widget frame alone is not a challenge');

  const refused = detectCloudflareChallenge({ frameUrls: [CHALLENGE_FRAME_URL], statusCode: 403 });
  assert.equal(refused.challenge, true, 'the same frame with a refusal is a challenge');
  assert.match(refused.markers.join(' | '), /a frame pointed at challenges.cloudflare.com/);

  // A normal page that merely mentions the company, its insights script or its dashboard is a page.
  const mention = detectCloudflareChallenge({
    title: 'Cloudflare protects this site',
    htmlMatches: challengeHtmlMatches('<p>Protected by cloudflare.com. Contact cloudflare support for help.</p><script src="https://static.cloudflareinsights.com/beacon.min.js"></script>'),
    frameUrls: ['https://example.com/embed'],
    statusCode: 200,
  });
  assert.equal(mention.challenge, false, 'the bare word cloudflare is not a marker');
  assert.deepEqual(mention.markers, []);

  // A plain 404 is not a challenge either, whatever status it answered.
  const notFound = detectCloudflareChallenge({
    title: 'Not Found',
    htmlMatches: challengeHtmlMatches('<h1>Not Found</h1><p>Nothing lives at this address.</p>'),
    statusCode: 404,
  });
  assert.equal(notFound.challenge, false);
  assert.deepEqual(notFound.markers, []);
});

test('the challenge note names the markers and the observed status without inventing one', () => {
  const detection = detectCloudflareChallenge({
    title: 'Attention Required! | Cloudflare',
    htmlMatches: ['cf-chl-'],
    frameUrls: [CHALLENGE_FRAME_URL],
    statusCode: 403,
  });
  assert.equal(
    challengeNote(detection),
    'The page looked like a Cloudflare challenge after the main document answered HTTP 403'
      + ' (the title matched "Attention Required", the document carried a cf-chl marker, a frame pointed at challenges.cloudflare.com).',
  );
  const withoutStatus = challengeNote(detectCloudflareChallenge({ title: 'Verifying you are human' }));
  assert.equal(withoutStatus, 'The page looked like a Cloudflare challenge (the title matched "Verifying you are human").');
});

// --- one bounded attempt ------------------------------------------------------------------------

test('solver off leaves an identified challenge exactly as it answered: no click, no extra navigation', async () => {
  const fixture = browserFixture({ steps: [{ status: 200, document: challengeDocument() }] });
  const result = await fixture.fetcher(request({ challengeSolver: 'off' }));

  assert.equal(fixture.page.clicks, 0, 'no click was sent');
  assert.deepEqual(fixture.page.clickedSelectors, []);
  assert.equal(fixture.page.loads, 1, 'the navigation was never retried');
  assert.equal(result.statusCode, 200);
  assert.ok(result.notes.some(note => /looked like a Cloudflare challenge/.test(note)), 'the shield page is named');
  assert.ok(result.notes.some(note => /solver is off, so the challenge page was left/.test(note)), 'the user is told why nothing happened');
  assert.equal(fixture.page.closed, true);

  // The same page answering 403 still gets the pre-existing anti-bot retry, and nothing more: `off`
  // adds no click and no navigation of its own on top of what the route already did.
  const refused = browserFixture({ steps: [{ status: 403, document: challengeDocument() }, { status: 403, document: challengeDocument() }] });
  const refusedResult = await refused.fetcher(request({ challengeSolver: 'off' }));
  assert.equal(refused.page.clicks, 0);
  assert.equal(refused.page.loads, 1, 'a challenge page is never reloaded: that would reset the challenge');
  assert.equal(refusedResult.outcome, 'http-error');
  assert.equal(refusedResult.statusCode, 403);
  assert.ok(refusedResult.notes.some(note => /solver is off, so the challenge page was left/.test(note)));
});

test('auto clears the widget: one click, no forced reload, and the resolved page decides', async () => {
  const fixture = browserFixture({
    steps: [
      { status: 200, document: challengeDocument() },
      { status: 200, document: realDocument() },
    ],
    afterClick: realDocument(),
  });
  const result = await fixture.fetcher(request({ challengeSolver: 'auto' }));

  assert.equal(fixture.page.clicks, 1, 'the widget was clicked exactly once');
  assert.deepEqual(fixture.page.clickedSelectors, ['input[type=checkbox]'], 'the click went through the challenge frame');
  assert.equal(fixture.page.loads, 1, 'the page resolved by itself, so nothing was reloaded');
  assert.equal(result.outcome, 'ok');
  assert.equal(result.statusCode, 200, 'the status of the resolved document is read, not invented');
  assert.match(result.html ?? '', /Example Domain/, 'the resolved document is the result');
  assert.doesNotMatch(result.html ?? '', /challenge-platform|cf-turnstile/, 'the challenge document is not returned');
  assert.ok(result.notes.some(note => /looked like a Cloudflare challenge/.test(note)));
  assert.ok(result.notes.some(note => /finished on its own after the widget cleared; no reload was made/.test(note)));
});

test('auto that never clears stays a 403 challenge page, with bounded polling and capped navigations', async () => {
  const fixture = browserFixture({
    steps: [
      { status: 403, document: challengeDocument() },
      { status: 403, document: challengeDocument('Just a moment...') },
    ],
  });
  const started = Date.now();
  const result = await fixture.fetcher(request({ challengeSolver: 'auto', routeTimeoutMs: 1_200 }));
  const elapsed = Date.now() - started;

  assert.equal(result.outcome, 'http-error', 'the refusal is kept, never fabricated as success');
  assert.equal(result.statusCode, 403);
  assert.equal(fixture.page.clicks, 1, 'exactly one press: pressing again while verifying restarts the challenge');
  assert.equal(fixture.page.loads, 1, 'nothing was reloaded: a reload cannot pass a challenge');
  assert.ok(fixture.page.loads <= MAX_FETCH_NAVIGATIONS);
  assert.ok(elapsed < 5_000, `the solve window is clipped by the route timeout (${elapsed}ms)`);
  assert.ok(result.notes.some(note => /looked like a Cloudflare challenge/.test(note)));
  assert.ok(result.notes.some(note => /still present when the solve window ended; it was not cleared/.test(note)));
  assert.ok(!result.notes.some(note => /it rendered a page, so the navigation was retried once/.test(note)), 'a challenge page is never treated as the rendered-real-page case');
});

test('a challenge page with no challenge frame is reported and left alone', async () => {
  // The document carries the markers but the driver reports no frame from the challenge host, which is
  // what a page that hides the widget behind its own markup looks like.
  const document: FakeDocument = { title: 'Checking your browser', html: '<html><head><title>Checking your browser</title></head><body><p>cf-turnstile placeholder</p></body></html>' };
  // A page that renders the markers itself but attaches no frame from the challenge host.
  const fetcher = createBrowserFetcher(async () => ({
    newContext: async () => ({
      newPage: async () => ({
        goto: async () => ({ status: () => 200 }),
        url: () => TARGET,
        waitForLoadState: async () => undefined,
        waitForFunction: async () => undefined,
        evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => runInPage(fn, argument, document),
        frames: () => [],
        close: async () => undefined,
      }),
      close: async () => undefined,
    }),
    close: async () => undefined,
  }) as never);
  const result = await fetcher(request({ challengeSolver: 'auto', routeTimeoutMs: 1_200 }));
  assert.equal(result.statusCode, 200);
  assert.ok(result.notes.some(note => /No frame pointed at challenges.cloudflare.com, so the automatic challenge attempt sent no click/.test(note)));
});

test('a cancel inside the solve window aborts promptly and releases page, context and browser', async () => {
  const fixture = browserFixture({ steps: [{ status: 403, document: challengeDocument() }, { status: 403, document: challengeDocument() }] });
  const controller = new AbortController();
  const started = Date.now();
  const pending = fixture.fetcher(request({ challengeSolver: 'auto', routeTimeoutMs: 8_000, signal: controller.signal }));
  setTimeout(() => controller.abort(), 250);
  const result = await pending;
  const elapsed = Date.now() - started;

  assert.equal(result.outcome, 'cancelled', 'an abort is a cancellation, not a challenge verdict');
  assert.ok(elapsed < 3_000, `the attempt stopped at the abort instead of polling the whole window (${elapsed}ms)`);
  assert.equal(fixture.page.closed, true, 'the page was closed');
  assert.equal(fixture.contextClosed(), true, 'the context was closed');
  assert.equal(fixture.browserClosed(), true, 'the browser client was closed');
});

// --- configuration ------------------------------------------------------------------------------

test('the solver defaults to auto, round-trips off through load, and rejects any other value', () => {
  const defaults = defaultConfig();
  assert.equal(defaults.pageFetch.browser.challengeSolver, 'auto', 'the default is one bounded attempt');
  assert.deepEqual(validateConfig(defaults), []);

  const saved = structuredClone(defaults) as SearchConfig;
  saved.pageFetch.browser.challengeSolver = 'off';
  assert.deepEqual(validateConfig(saved), [], 'off is a valid saved value');
  assert.equal(parseConfig(saved).pageFetch.browser.challengeSolver, 'off', 'off round-trips through save and load');

  // A file written before this setting existed gets the default instead of failing the whole load.
  const older = structuredClone(defaults) as unknown as { pageFetch: { browser: Record<string, unknown> } };
  delete older.pageFetch.browser.challengeSolver;
  assert.equal(parseConfig(older).pageFetch.browser.challengeSolver, 'auto');

  const invalid = structuredClone(defaults) as SearchConfig;
  (invalid.pageFetch.browser as { challengeSolver: string }).challengeSolver = 'always';
  const issues = validateConfig(invalid);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.path, 'pageFetch.browser.challengeSolver');
  assert.equal(issues[0]?.code, 'field.unsupported');
});

test('a configuration with only the HTTP route never touches the browser route', async () => {
  const config = defaultConfig();
  // The browser route stays disabled, and the shared endpoint is configured: nothing about the new
  // setting may reach the HTTP or provider path.
  config.browser.endpoint = 'ws://127.0.0.1:3030/ws';
  assert.deepEqual(validateConfig(config), []);

  let attaches = 0;
  const engine = createPageFetchEngine(config, {
    fetcher: (async () => new Response(
      '<html><head><title>Example</title></head><body><p>Served over plain HTTP.</p></body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    )) as unknown as typeof fetch,
    resolver: async () => ['93.184.216.34'],
    browser: async () => {
      attaches += 1;
      throw new Error('the browser route must not run');
    },
  });
  const result = await engine.fetchPage({ url: 'https://example.com/', format: 'markdown' });
  assert.equal(attaches, 0, 'no browser client was attached');
  assert.equal(result.ok, true);
  assert.equal(result.contentRoute, 'http');
  assert.equal(result.statusCode, 200);
  assert.ok(result.notes.every(note => !/Cloudflare challenge/.test(note)), 'no challenge note on an HTTP-only run');
});

test('a widget that is in the document but not laid out yet is clicked once it has a size', async () => {
  // The first two geometry reads see the real 0x0 frame a challenge page starts with. Clicking there
  // lands on the page behind the widget, which is what a real attempt did before this was fixed.
  const fixture = browserFixture({
    steps: [{ status: 403, document: challengeDocument() }],
    layoutAfterReads: 2,
  });
  const result = await fixture.fetcher(request());
  assert.ok(fixture.page.clicks >= 1, 'the widget was pressed after it gained a size');
  assert.match(fixture.page.clickedSelectors[0] ?? '', /checkbox|challenge-stage|body/);
  assert.equal(result.statusCode, 403, 'a challenge that never clears keeps its status');
});

test('a healthy page that embeds Turnstile is not reported as a challenge', () => {
  // linux.do answers 200, renders its forum, and still loads challenge-platform plus a Turnstile
  // frame for its own login form. That page must never enter the solver.
  const forum = detectCloudflareChallenge({
    title: 'LINUX DO - 新的理想型社区',
    htmlMatches: challengeHtmlMatches('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script><div class="cf-turnstile"></div><script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/main.js"></script>'),
    frameUrls: [CHALLENGE_FRAME_URL],
    statusCode: 200,
  });
  assert.equal(forum.challenge, false);
  assert.deepEqual(forum.markers, []);

  // An interstitial marker still decides on its own, whatever the status says.
  const interstitial = detectCloudflareChallenge({
    title: 'linux.do',
    htmlMatches: challengeHtmlMatches('<script>window._cf_chl_opt={cvId:"3"}</script>'),
    statusCode: 200,
  });
  assert.equal(interstitial.challenge, true);
});

test('a page that answers 200 while embedding Turnstile is fetched, not challenged', async () => {
  const forum = {
    title: 'LINUX DO - 新的理想型社区',
    html: '<html><head><title>LINUX DO - 新的理想型社区</title>'
      + '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head>'
      + '<body><div class="cf-turnstile"></div><main>' + '论坛正文 '.repeat(80) + '</main></body></html>',
  };
  const fixture = browserFixture({ steps: [{ status: 200, document: forum }] });
  const result = await fixture.fetcher(request());
  assert.equal(result.outcome, 'ok');
  assert.equal(result.statusCode, 200);
  assert.equal(fixture.page.clicks, 0, 'no click was attempted on a healthy page');
  assert.equal(fixture.page.loads, 1, 'and no extra navigation either');
  assert.ok(!result.notes.some(note => /Cloudflare challenge/.test(note)), 'no challenge note is written');
});

test('a page that clears slowly still gets its render window instead of being closed early', async () => {
  // The widget clears at once, but the forum behind it boots for six seconds — past the render window a
  // plain page load gets. The route must wait, not close the window on a page that is still rendering.
  const slowPage = {
    title: 'LINUX DO - 新的理想型社区',
    html: '<html><head><title>LINUX DO</title></head><body>' + '论坛帖子 '.repeat(120) + '</body></html>',
  };
  const fixture = browserFixture({
    steps: [{ status: 200, document: challengeDocument() }],
    afterClick: slowPage,
    renderDelayMs: 6_000,
  });
  const result = await fixture.fetcher(request({ routeTimeoutMs: 20_000 }));
  assert.equal(fixture.page.clicks, 1, 'one press only');
  assert.equal(result.outcome, 'ok', 'the slowly rendered document is the result');
  assert.ok(result.notes.some(note => /finished on its own after the widget cleared/.test(note)));
});

test('a pressed widget keeps its wait past the plain solve window', async () => {
  // The challenge clears only after the solve window would have ended; the press buys the longer render
  // window instead of the attempt being cut off while the platform is still verifying.
  const lateDocument = {
    title: 'LINUX DO - 新的理想型社区',
    html: '<html><head><title>LINUX DO</title></head><body>' + '论坛帖子 '.repeat(120) + '</body></html>',
  };
  const fixture = browserFixture({
    steps: [{ status: 403, document: challengeDocument() }],
    afterClick: lateDocument,
    renderDelayMs: 2_500,
  });
  const result = await fixture.fetcher(request({ routeTimeoutMs: 20_000 }));
  assert.equal(fixture.page.clicks, 1);
  assert.equal(result.outcome, 'ok', 'the late render is still accepted');
  assert.equal(fixture.page.loads, 1, 'and nothing was reloaded');
});
