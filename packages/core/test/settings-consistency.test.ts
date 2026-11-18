import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateConfig } from '../src/config.js';
import { catalog } from '../src/catalog.js';
import { collectBrowserDependencies, verifyBrowserDependencies, verifyBrowserEndpoint } from '../src/browser-verification.js';
import type { VerificationBrowser, VerificationContext } from '../src/browser-verification.js';
import type { SearchConfig } from '../src/types.js';

/**
 * The save-time browser gate and the structured configuration issues a settings page localizes.
 * Every check here is deterministic: the transport is injected, nothing opens a socket.
 */

const xhs = (config: SearchConfig): SearchConfig['backends'][string] => config.backends.xiaohongshu!;

function browserEnabled(change: (config: SearchConfig) => void = () => undefined): SearchConfig {
  const config = defaultConfig();
  const row = xhs(config);
  row.enabled = true;
  row.mode = 'browser';
  row.endpoint = '';
  config.browser.endpoint = 'ws://127.0.0.1:3030/ws';
  change(config);
  return config;
}

interface Track { connects: number; contexts: number; contextClosed: number; browserClosed: number; endpoints: string[]; headers: Array<Record<string, string> | undefined> }

function track(): Track {
  return { connects: 0, contexts: 0, contextClosed: 0, browserClosed: 0, endpoints: [], headers: [] };
}

function fakeBrowser(state: Track, failContext = false): VerificationBrowser {
  return {
    async newContext() {
      state.contexts += 1;
      if (failContext) throw new Error('context creation refused');
      const context: VerificationContext = { close: async () => { state.contextClosed += 1; } };
      return context;
    },
    async close() { state.browserClosed += 1; },
  };
}

const connectFor = (state: Track, failContext = false) => async (endpoint: string, options: { timeout: number; headers?: Record<string, string> }) => {
  state.connects += 1;
  state.endpoints.push(endpoint);
  state.headers.push(options.headers);
  return fakeBrowser(state, failContext);
};

// --- structured issues ------------------------------------------------------------------------

test('route issues keep their index path, name the route kind and point at the browser endpoint', () => {
  const config = defaultConfig() as unknown as Record<string, any>;
  // Reorder the routes so the browser record is no longer at index 1.
  config.pageFetch.routes = [config.pageFetch.routes[1], config.pageFetch.routes[0], config.pageFetch.routes[2]];
  assert.equal(config.pageFetch.routes[0].kind, 'browser');
  config.pageFetch.routes[0].enabled = true; // the browser route now sits first
  config.pageFetch.providerId = 'exa';
  const issues = validateConfig(config);
  const browserRoute = issues.find(issue => issue.path === 'pageFetch.routes.0.enabled' && issue.code === 'pageFetch.route.browserEndpointMissing');
  assert.ok(browserRoute, `expected a browser-route issue, got ${issues.map(issue => `${issue.path}:${issue.code}`).join(', ')}`);
  assert.equal(browserRoute.params?.kind, 'browser', 'the issue identifies the route by kind, not by index');
  assert.equal(browserRoute.action?.target, 'browser.endpoint', 'the fix target is the shared browser endpoint');
  assert.match(browserRoute.message, /browser endpoint/i, 'the plain message stays complete without localization');

  // Enabling the route is the delegated decision: there is no second switch to leave off, and no
  // issue may send the user to one.
  const delegated = issues.find(issue => issue.code === 'pageFetch.route.delegatedOff');
  assert.equal(delegated, undefined, 'a delegated route has no separate opt-in to satisfy');
  assert.equal(validateConfig(config).some(issue => issue.action?.target === 'pageFetch.allowDelegatedFetching'), false);
});

test('invalid rule paths stay deep and carry a condition code plus the route kind', () => {
  const config = defaultConfig() as unknown as Record<string, any>;
  config.pageFetch.routes[0].rules[0].conditions[0] = { type: 'api-status', statuses: [200] };
  const issue = validateConfig(config).find(item => item.path === 'pageFetch.routes.0.rules.0.conditions.0');
  assert.ok(issue, 'the issue names the exact condition, not the route');
  assert.equal(issue.code, 'condition.apiStatus.route');
  assert.equal(issue.params?.kind, 'http', 'the owning route kind travels with the issue');
  assert.match(issue.message, /provider route/);
});

test('provider fetch operation issues name the provider, mode and endpoint field', () => {
  const config = defaultConfig() as unknown as Record<string, any>;
  config.pageFetch.routes[2].enabled = true;
  config.pageFetch.providerId = 'exa';
  // Exa fetches in anonymous and key modes; `oauth` is a search mode it never declared for fetching.
  config.backends.exa.fetch.mode = 'oauth';
  const issue = validateConfig(config).find(item => item.path === 'backends.exa.fetch.mode');
  assert.ok(issue, 'a fetch mode the provider never declared is rejected at its own path');
  assert.equal(issue.code, 'backend.fetch.mode.unsupported');
  assert.equal(issue.params?.provider, 'exa');
  assert.match(String(issue.params?.mode), /oauth/);
});

test('both documented keyed fetch modes are valid and keep their own REST endpoint', () => {
  const config = defaultConfig() as unknown as Record<string, any>;
  config.pageFetch.routes[2].enabled = true;
  for (const [id, endpoint] of [['exa', 'https://api.exa.ai/contents'], ['parallel', 'https://api.parallel.ai/v1/extract']] as const) {
    config.pageFetch.providerId = id;
    config.backends[id].fetch.mode = 'key';
    // A saved row that still carries the earlier anonymous endpoint keeps validating: the endpoint is
    // only defaulted from the declared fetch endpoint, never required to match it.
    config.backends[id].fetch.endpoint = '';
    assert.deepEqual(validateConfig(config).filter(item => item.path.startsWith(`backends.${id}.fetch`)), [], `${id} key mode validates`);
    assert.equal(catalog.find(item => item.id === id)!.modes.find(mode => mode.mode === 'key')!.fetchEndpoint, endpoint);
  }
});

test('malformed saves are reported as paths, never as raw TypeErrors', () => {
  const notObject = validateConfig(null);
  assert.equal(notObject[0]?.code, 'config.notObject');
  assert.equal(notObject[0]?.path, 'config');

  const malformed = defaultConfig() as unknown as Record<string, any>;
  malformed.pageFetch.routes = [null, null, null];
  const routeIssues = validateConfig(malformed);
  assert.ok(routeIssues.some(issue => issue.code === 'pageFetch.routes.records' && issue.path === 'pageFetch.routes'));

  const unknown = defaultConfig() as unknown as Record<string, any>;
  unknown.pageFetch.routes[0].rules[0].extra = true;
  const unknownIssue = validateConfig(unknown).find(item => item.path === 'pageFetch.routes.0.rules.0.extra');
  assert.equal(unknownIssue?.code, 'rule.field.unknown');
  assert.equal(unknownIssue?.params?.field, 'extra');

  const malformedNumber = defaultConfig() as unknown as Record<string, any>;
  malformedNumber.maxResults = 0;
  const range = validateConfig(malformedNumber).find(item => item.path === 'maxResults');
  assert.equal(range?.code, 'field.range');
  assert.deepEqual(range?.params, { min: 1, max: 50 });
});

test('every issue still carries a readable fallback message and a path', () => {
  const config = defaultConfig() as unknown as Record<string, any>;
  config.pageFetch.routes[0].rules = [{ id: 'x', enabled: true, conditions: [{ type: 'match', field: 'text', operator: 'regex', value: '(?=secret)', caseSensitive: true }] }];
  config.pageFetch.routes[1].enabled = true;
  for (const issue of validateConfig(config)) {
    assert.ok(issue.path.length > 0, 'a path is always present');
    assert.ok(issue.message.length > 0, 'an English message is always present');
  }
});

// --- save gate ---------------------------------------------------------------------------------

test('enabled browser search and fetch dependents share one grouped probe', async () => {
  const state = track();
  const config = browserEnabled(inner => {
    inner.pageFetch.routes[1]!.enabled = true;
  });
  assert.equal(collectBrowserDependencies(config).length, 2, 'one search backend and the fetch route');
  const result = await verifyBrowserDependencies(config, { connect: connectFor(state) });
  assert.equal(result.ok, true);
  assert.equal(state.connects, 1, 'identical endpoint and token pairs are checked once');
  assert.equal(state.contexts, 1);
  assert.equal(state.contextClosed, 1, 'the probe context is closed');
  assert.equal(state.browserClosed, 1, 'the probe connection is released');
  assert.equal(result.checks[0]?.endpoint, 'ws://127.0.0.1:3030/ws');
});

test('no enabled browser dependency saves offline without a connection', async () => {
  const state = track();
  const config = defaultConfig();
  const result = await verifyBrowserDependencies(config, { connect: connectFor(state) });
  assert.equal(result.ok, true);
  assert.equal(state.connects, 0);
  assert.deepEqual(result.checks, []);
});

test('the shared endpoint wins and the backend endpoint is only the fallback', async () => {
  const fallbackState = track();
  const fallback = browserEnabled(inner => {
    inner.browser.endpoint = '';
    xhs(inner).endpoint = 'ws://127.0.0.1:4040/ws';
  });
  await verifyBrowserDependencies(fallback, { connect: connectFor(fallbackState) });
  assert.deepEqual(fallbackState.endpoints, ['ws://127.0.0.1:4040/ws'], 'without a shared endpoint the backend fallback is used');

  const sharedState = track();
  const shared = browserEnabled(inner => { xhs(inner).endpoint = 'ws://127.0.0.1:4040/ws'; });
  await verifyBrowserDependencies(shared, { connect: connectFor(sharedState) });
  assert.deepEqual(sharedState.endpoints, ['ws://127.0.0.1:3030/ws'], 'a filled shared endpoint beats the backend fallback');
});

test('the fetch browser route never borrows a search backend fallback', async () => {
  const state = track();
  const config = defaultConfig();
  config.browser.endpoint = '';
  xhs(config).enabled = true;
  xhs(config).mode = 'browser';
  xhs(config).endpoint = 'ws://127.0.0.1:4040/ws';
  config.pageFetch.routes[1]!.enabled = true;
  const result = await verifyBrowserDependencies(config, { connect: connectFor(state) });
  assert.deepEqual(state.endpoints, ['ws://127.0.0.1:4040/ws'], 'only the search backend can use its own fallback');
  const routeIssue = result.issues.find(issue => issue.path === 'pageFetch.routes.1.enabled');
  assert.equal(routeIssue?.code, 'browser.endpoint.missing');
  assert.equal(routeIssue?.params?.kind, 'fetch-browser-route');
  assert.equal(result.ok, false);
});

test('a rejected token is a structured authentication issue on every dependent', async () => {
  const config = browserEnabled(inner => {
    inner.pageFetch.routes[1]!.enabled = true;
  });
  const result = await verifyBrowserDependencies(config, {
    resolveToken: () => 'SUPER_SECRET_TOKEN',
    connect: async () => { throw new Error('connect failed: 401 Unauthorized'); },
  });
  assert.equal(result.ok, false);
  assert.deepEqual([...new Set(result.issues.map(issue => issue.code))], ['browser.authRejected']);
  assert.deepEqual(result.issues.map(issue => issue.path).sort(), ['backends.xiaohongshu.enabled', 'pageFetch.routes.1.enabled']);
  assert.ok(result.issues.every(issue => issue.action?.target === 'browser.endpoint'));
  assert.ok(!JSON.stringify(result).includes('SUPER_SECRET_TOKEN'), 'a token never appears in a result');
});

test('an unreachable endpoint and a version mismatch are different causes', async () => {
  const config = browserEnabled();
  const unreachable = await verifyBrowserDependencies(config, { connect: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3030'); } });
  assert.equal(unreachable.issues[0]?.code, 'browser.unreachable');
  const mismatch = await verifyBrowserDependencies(config, { connect: async () => { throw new Error('Version mismatch between client and server'); } });
  assert.equal(mismatch.issues[0]?.code, 'browser.protocolMismatch');
});

test('a late connection is closed instead of leaking, and a deadline is reported as a timeout', async () => {
  const state = track();
  const late = new Promise<VerificationBrowser>(resolve => {
    setTimeout(() => resolve(fakeBrowser(state)), 50);
  });
  // The issue reports the *remaining* total budget, not the configured constant: on a real clock a
  // 20 ms check can report 19 because a millisecond went to scheduling. A frozen clock makes the
  // assertion exact without pinning a number the save path does not promise.
  const result = await verifyBrowserDependencies(browserEnabled(), {
    timeoutMs: 20,
    now: () => 0,
    connect: () => { state.connects += 1; return late; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0]?.code, 'browser.timeout');
  const reported = Number(result.issues[0]?.params?.timeoutMs);
  assert.equal(reported, 20, 'with no budget spent yet, the whole 20 ms is what remains');
  assert.ok(Number.isInteger(reported) && reported >= 1 && reported <= 20, 'the reported bound is a positive part of the configured budget');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(state.browserClosed, 1, 'the browser that arrived after the deadline was closed');
  assert.equal(state.contexts, 0, 'no context was created after the deadline');
});

test('time spent before the probe is deducted from the one total budget', async () => {
  // The clock advances during the token read, exactly as a slow credential store would.
  let clock = 0;
  const result = await verifyBrowserDependencies(browserEnabled(), {
    timeoutMs: 20,
    now: () => clock,
    resolveToken: () => { clock = 6; return undefined; },
    connect: () => new Promise<VerificationBrowser>(() => undefined),
  });
  assert.equal(result.issues[0]?.code, 'browser.timeout');
  assert.equal(result.issues[0]?.params?.timeoutMs, 14, 'a check that already spent 6 ms of 20 reports the remaining 14');
});

test('a context failure closes the browser and reports the context cause', async () => {
  const state = track();
  const result = await verifyBrowserDependencies(browserEnabled(), { connect: connectFor(state, true) });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0]?.code, 'browser.contextFailed');
  assert.equal(state.browserClosed, 1);
});

test('a missing effective endpoint is refused before any connection', async () => {
  const state = track();
  const config = browserEnabled(inner => { inner.browser.endpoint = ''; });
  const result = await verifyBrowserDependencies(config, { connect: connectFor(state) });
  assert.equal(result.ok, false);
  assert.equal(state.connects, 0);
  assert.equal(result.issues[0]?.code, 'browser.endpoint.missing');
  assert.equal(result.issues[0]?.path, 'backends.xiaohongshu.enabled');
});

test('a token read that overruns the budget refuses the save instead of passing it', async () => {
  let connects = 0;
  const result = await verifyBrowserDependencies(browserEnabled(), {
    timeoutMs: 20,
    resolveToken: () => new Promise<string>(() => undefined),
    connect: async () => { connects += 1; return fakeBrowser(track()); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0]?.code, 'browser.timeout');
  assert.equal(connects, 0, 'no endpoint is probed without a token verdict');
});

test('an aborted check refuses and closes a browser that arrives late', async () => {
  const state = track();
  const controller = new AbortController();
  const late = new Promise<VerificationBrowser>(resolve => {
    setTimeout(() => resolve(fakeBrowser(state)), 40);
  });
  const pending = verifyBrowserDependencies(browserEnabled(), {
    timeoutMs: 1_000,
    signal: controller.signal,
    connect: () => { state.connects += 1; return late; },
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, /cancelled/i);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(state.browserClosed, 1, 'the late connection is cleaned up after cancellation');
  assert.equal(state.contexts, 0);
});

test('an already-aborted signal refuses before any probe', async () => {
  const state = track();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(verifyBrowserDependencies(browserEnabled(), { signal: controller.signal, connect: connectFor(state) }), /cancelled/i);
  assert.equal(state.connects, 0);
});

test('a credential-store failure rejects the check instead of passing it', async () => {
  let connects = 0;
  await assert.rejects(
    verifyBrowserDependencies(browserEnabled(), {
      resolveToken: () => { throw new Error('credential store unavailable'); },
      connect: async () => { connects += 1; return fakeBrowser(track()); },
    }),
    /credential store unavailable/,
  );
  assert.equal(connects, 0, 'a failed token read is never treated as a savable result');
});

test('a slow context close cannot extend the save beyond the deadline', async () => {
  const timeoutMs = 60;
  const started = Date.now();
  const result = await verifyBrowserDependencies(browserEnabled(), {
    timeoutMs,
    connect: async () => ({
      newContext: async () => ({ close: () => new Promise<void>(() => undefined) }),
      close: async () => undefined,
    }),
  });
  assert.equal(result.ok, true, 'the context was created, so the endpoint is verified');
  assert.ok(Date.now() - started < 1_000, 'the bounded teardown returned instead of waiting for the close');
});

test('a non-WebSocket endpoint is refused before connecting', async () => {
  const state = track();
  const config = browserEnabled(inner => { inner.browser.endpoint = 'https://browser.example.com'; });
  const result = await verifyBrowserDependencies(config, { connect: connectFor(state) });
  assert.equal(state.connects, 0);
  assert.equal(result.issues[0]?.code, 'browser.endpoint.invalid');
});

test('the stored token is sent as a bearer header and never echoed', async () => {
  const state = track();
  const result = await verifyBrowserDependencies(browserEnabled(), { resolveToken: () => 'ENDPOINT_TOKEN', connect: connectFor(state) });
  assert.equal(result.ok, true);
  assert.deepEqual(state.headers[0], { authorization: 'Bearer ENDPOINT_TOKEN' });
  assert.ok(!JSON.stringify(result).includes('ENDPOINT_TOKEN'));
});

test('the manual check validates the protocol and uses only the stored token', async () => {
  const invalid = await verifyBrowserEndpoint('http://127.0.0.1:3030/ws');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'browser.endpoint.invalid');
  const missing = await verifyBrowserEndpoint('');
  assert.equal(missing.code, 'browser.endpoint.missing');
  const state = track();
  const ok = await verifyBrowserEndpoint('ws://127.0.0.1:3030/ws', { resolveToken: () => 'TOKEN', connect: connectFor(state) });
  assert.equal(ok.ok, true);
  assert.equal(state.contextClosed, 1);
  assert.ok(!JSON.stringify(ok).includes('TOKEN'));
});

test('catalog sharing the browser is the only source of browser dependencies', () => {
  const browserCapable = catalog.filter(item => item.modes.some(mode => mode.mode === 'browser')).map(item => item.id);
  assert.deepEqual(browserCapable, ['xiaohongshu'], 'the fixture assumes the browser-capable search set');
});
