import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply as productionApply, createPlugin, defaultConfig } from '../src/index.js';
import { backendIdForPath, browserGateIssues, classifySaveOutcome, fieldId, focusForIssue, focusForPath, focusRenderedControl, routeKindForPath, shouldResetBackendFilter, tabForPath } from '../src/presenter.js';
import { catalog, revision } from '@nite07/search-core';
import type { SearchConfig, VerificationConnect } from '@nite07/search-core';

/**
 * The DSH save gate and the presentation mapping that decides where a rejection lands.
 * The transport is injected, so no test opens a browser socket. The compiled module's default
 * `apply` is checked once to prove the production entry still exists.
 */

interface Harness {
  ctx: any;
  routes: Map<string, any>;
  secrets: Map<string, string>;
  stored: () => any;
  writes: () => number;
  apply: (config: SearchConfig) => Promise<void>;
  setCurrent: (config: unknown) => void;
  setInherited: (config: unknown) => void;
  tool: (name: string) => any;
  connects: string[];
  headers: Array<Record<string, string> | undefined>;
}

function harness(options: { connect?: VerificationConnect; tokenReadError?: boolean } = {}): Harness {
  const routes = new Map<string, any>();
  const definitions: Record<string, any> = {};
  const secrets = new Map<string, string>();
  const records = new Map();
  let stored: any;
  let currentConfig: any = {};
  let inheritedConfig: any = {};
  let writes = 0;
  const connects: string[] = [];
  const headers: Array<Record<string, string> | undefined> = [];
  const connect: VerificationConnect = options.connect ?? (async (endpoint, opts) => {
    connects.push(endpoint);
    headers.push(opts.headers);
    return { newContext: async () => ({ close: async () => undefined }), close: async () => undefined };
  });
  const table = { get: (k: string) => records.get(k), entries: () => records.entries(), put: async (k: string, v: any) => { records.set(k, v); } };
  const ctx: any = {
    fiber: { entry: { id: 'test' } },
    effect(fn: any) { return fn(); },
    web: { registerSearchProvider() { return () => {}; } },
    credentials: {
      resolve: async (ref: string) => { if (options.tokenReadError) throw new Error('credential store offline'); return secrets.has(ref) ? { value: secrets.get(ref) } : undefined; },
      describe: async (ref: string) => ({ configured: secrets.has(ref), writable: true }),
      set: async (ref: string, value: string) => { secrets.set(ref, value); },
      unset: async (ref: string) => { secrets.delete(ref); },
    },
    configEditor: {
      edit: async (_entry: any, fn: any) => {
        // The SDK calls back under its file lock with the explicit entry config plus the inherited layer.
        const next = fn(structuredClone(currentConfig), structuredClone(inheritedConfig));
        writes += 1;
        currentConfig = next;
        stored = next;
      },
      configuration: () => [{ entry: { options: { id: 'web' } }, inherited: {}, override: { searchProvider: 'nite-search', fetchProvider: 'http' } }],
    },
    storageDomain: { open: async () => ({ table: () => table, close: async () => undefined }) },
    get(name: string) {
      if (name === 'connection') return { fetch: { register: (route: any) => { routes.set(route.path, route); return async () => undefined; } } };
      if (name === 'tools') return { register: (definition: any) => { definitions[definition.name] = definition; return () => undefined; } };
    },
  };
  const plugin = createPlugin({ browserConnect: connect });
  return {
    ctx, routes, secrets,
    stored: () => stored,
    writes: () => writes,
    apply: (config: SearchConfig) => { currentConfig = structuredClone(config); return plugin(ctx, config); },
    setCurrent: (config: unknown) => { currentConfig = structuredClone(config); },
    setInherited: (config: unknown) => { inheritedConfig = structuredClone(config); },
    tool: (name: string) => definitions[name],
    connects, headers,
  };
}

const browserConfig = (): SearchConfig => {
  const config = defaultConfig();
  config.browser.endpoint = 'ws://127.0.0.1:3030/ws';
  config.backends.xiaohongshu!.enabled = true;
  config.backends.xiaohongshu!.mode = 'browser';
  config.backends.xiaohongshu!.endpoint = '';
  return config;
};

async function snapshotOf(h: Harness): Promise<any> {
  return h.tool('search_manage').execute({ action: 'settings' }, { signal: new AbortController().signal });
}

function post(route: any, body: unknown): Promise<Response> {
  return route.fetch(new Request('https://localhost/api/nite-search/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

// --- presentation mapping -----------------------------------------------------------------------

test('issue focus maps provider fetch fields to the Fetch tab and browser fields to the Browser tab', () => {
  assert.deepEqual(focusForPath('backends.exa.fetch.endpoint'), { tab: 'fetch', target: 'backends.exa.fetch.endpoint' });
  assert.deepEqual(focusForPath('backends.exa.fetch.options.maxCharacters'), { tab: 'fetch', target: 'backends.exa.fetch.options.maxCharacters' });
  assert.deepEqual(focusForPath('browser.endpoint'), { tab: 'browser', target: 'browser.endpoint' });
  assert.deepEqual(focusForPath('browser.maxConcurrentReads'), { tab: 'browser', target: 'browser.maxConcurrentReads' });
  // Fetch-only browser options stay with the fetch operation they describe.
  assert.deepEqual(focusForPath('pageFetch.browser.context'), { tab: 'fetch', target: 'pageFetch.browser.context' });
  assert.deepEqual(focusForPath('pageFetch.routes.1.rules.0.conditions.0.value'), { tab: 'fetch', target: 'pageFetch.routes.1.rules.0.conditions.0.value' });
  assert.deepEqual(focusForPath('retry.maxRetries'), { tab: 'reliability', target: 'retry.maxRetries' });
  assert.deepEqual(focusForPath('cache.ttlSeconds'), { tab: 'reliability', target: 'cache.ttlSeconds' });
  assert.deepEqual(focusForPath('maxResults'), { tab: 'behavior', target: 'maxResults' });
  assert.equal(tabForPath('pageFetch.browser.settleMs'), 'fetch');
});

test('a route label follows the route record through a reorder', () => {
  const routes = [{ kind: 'provider' }, { kind: 'browser' }, { kind: 'http' }];
  assert.equal(routeKindForPath(routes, 'pageFetch.routes.1.enabled'), 'browser');
  assert.equal(routeKindForPath(routes, 'pageFetch.routes.0.rules.2.conditions.0'), 'provider');
  assert.equal(routeKindForPath(routes, 'backends.exa.fetch.mode'), undefined);
});

test('an issue action target wins, so a browser-route rejection lands on the shared endpoint', () => {
  assert.deepEqual(
    focusForIssue({ path: 'pageFetch.routes.2.enabled', action: { target: 'browser.endpoint' } }),
    { tab: 'browser', target: 'browser.endpoint' },
  );
  assert.deepEqual(focusForIssue({ path: 'backends.xiaohongshu.enabled', action: { target: 'browser.endpoint' } }), { tab: 'browser', target: 'browser.endpoint' });
  assert.deepEqual(focusForIssue({ path: 'backends.exa.fetch.mode' }), { tab: 'fetch', target: 'backends.exa.fetch.mode' });
});

test('the focus resolver walks to the closest mounted control and unfolds its details', () => {
  interface Node { id: string; parentElement: Node | null; details: Node | null; focused: boolean; scrolled: boolean; open?: boolean;
    closest(selector: string): Node | null;
    focus?(): void;
    scrollIntoView?(): void; }
  const make = (id: string): Node => ({
    id, parentElement: null, details: null, focused: false, scrolled: false,
    closest(selector: string) { return selector === 'details' ? this.details : null; },
    focus() { this.focused = true; },
    scrollIntoView() { this.scrolled = true; },
  });
  const body = make('body');
  const wrapper = make('wrapper'); body.details = null; wrapper.parentElement = body;
  const providerGroup = make(fieldId('pageFetch.providerId')); providerGroup.parentElement = body;
  const ruleDetails = make('rule-details'); const rule = make(fieldId('pageFetch.routes.0.rules.0')); rule.parentElement = ruleDetails; rule.details = ruleDetails;
  const nodes = new Map([[providerGroup.id, providerGroup], [rule.id, rule]]);
  const doc = { getElementById: (id: string) => nodes.get(id) || null };
  const provider = focusRenderedControl(doc, 'pageFetch.providerId');
  assert.equal(provider, providerGroup, 'the provider radio group is addressable');
  assert.equal(providerGroup.focused, true);
  assert.equal(providerGroup.scrolled, true);
  const deepRule = focusRenderedControl(doc, 'pageFetch.routes.0.rules.0.conditions.2.value');
  assert.equal(deepRule, rule, 'a deep condition path falls back to the rule container');
  assert.equal(ruleDetails.open, true, 'the closed rules details is unfolded');
  assert.equal(focusRenderedControl(doc, 'pageFetch.routes.9.enabled'), undefined, 'an unmounted target is reported instead of throwing');
});

test('a backend filter is reset before focusing a hidden backend card', () => {
  assert.equal(backendIdForPath('backends.keenable.enabled'), 'keenable');
  assert.equal(backendIdForPath('pageFetch.routes.0.enabled'), undefined);
  assert.equal(shouldResetBackendFilter('backends.keenable.enabled', 'keen', 'all'), true);
  assert.equal(shouldResetBackendFilter('backends.keenable.enabled', '', 'enabled'), true);
  assert.equal(shouldResetBackendFilter('backends.keenable.enabled', '', 'all'), false);
  assert.equal(shouldResetBackendFilter('selfRef', 'keen', 'enabled'), false);
});

test('save outcomes are classified from the response and a read-back, never guessed', () => {
  const issue = { path: 'maxResults', message: 'bad', code: 'field.range' };
  const rejected = classifySaveOutcome({ response: { status: 400, payload: { error: { code: 'validation-failed', message: 'rejected', issues: [issue] } } } });
  assert.deepEqual(rejected, { kind: 'rejected', code: 'validation-failed', issues: [issue] });
  assert.deepEqual(classifySaveOutcome({ response: { status: 409, payload: { error: { code: 'revision-conflict', message: 'stale' } } } }), { kind: 'conflict' });
  assert.deepEqual(classifySaveOutcome({ response: { status: 200, payload: { saved: true } }, readback: { ok: true, matches: true } }), { kind: 'saved' });
  assert.deepEqual(classifySaveOutcome({ response: { status: 200, payload: { saved: true } }, readback: { ok: true, matches: false } }), { kind: 'conflict' });
  assert.deepEqual(
    classifySaveOutcome({ response: { status: 500, payload: { error: { code: 'save-failed', message: 'disk full' } } }, readback: { ok: true, matches: false } }),
    { kind: 'write-failed', code: 'save-failed', message: 'disk full' },
  );
  assert.deepEqual(classifySaveOutcome({ response: { status: 500, payload: { error: { code: 'save-failed', message: 'disk full' } } }, readback: { ok: true, matches: true } }), { kind: 'saved' });
  assert.deepEqual(classifySaveOutcome({ response: { status: 500, payload: { error: { code: 'save-failed', message: 'disk full' } } }, readback: { ok: false } }), { kind: 'state-unknown' });
  assert.deepEqual(classifySaveOutcome({ transportError: true, readback: { ok: true, matches: true } }), { kind: 'saved' });
  assert.deepEqual(classifySaveOutcome({ transportError: true, readback: { ok: true, matches: false } }), { kind: 'unconfirmed' });
  assert.deepEqual(classifySaveOutcome({ transportError: true, readback: { ok: false } }), { kind: 'state-unknown' });
  assert.deepEqual(classifySaveOutcome({ transportError: true }), { kind: 'state-unknown' });
});

test('the front-end gate explains a missing endpoint only while a browser dependency is enabled', () => {
  const disabled = defaultConfig();
  assert.deepEqual(browserGateIssues(disabled), [], 'disabled browser settings stay saveable offline');

  const search = browserConfig();
  search.browser.endpoint = '';
  const searchIssues = browserGateIssues(search);
  assert.equal(searchIssues.length, 1);
  assert.equal(searchIssues[0]?.code, 'browser.endpoint.missing');
  assert.equal(searchIssues[0]?.path, 'backends.xiaohongshu.enabled');
  assert.equal(searchIssues[0]?.action?.target, 'browser.endpoint');

  const fetch = defaultConfig();
  fetch.pageFetch.routes[1]!.enabled = true;
  fetch.pageFetch.allowDelegatedFetching = true;
  const fetchIssues = browserGateIssues(fetch);
  assert.ok(fetchIssues.some(issue => issue.code === 'pageFetch.route.browserEndpointMissing' && issue.action?.target === 'browser.endpoint'));

  const invalid = browserConfig();
  invalid.browser.endpoint = 'https://browser.example.com';
  assert.ok(browserGateIssues(invalid).some(issue => issue.code === 'browser.endpoint.invalid'));
});

// --- save semantics -----------------------------------------------------------------------------

test('the production entry point is exported and validating saves reject before any write', async () => {
  assert.equal(typeof productionApply, 'function');
  const h = harness();
  await h.apply(defaultConfig());
  const snapshot = await snapshotOf(h);
  const invalid = structuredClone(defaultConfig()) as any;
  invalid.maxResults = 0;
  await assert.rejects(
    h.tool('search_manage').execute({ action: 'save', config: invalid, expectedRevision: snapshot.revision }, { signal: new AbortController().signal }),
    /rejected by validation/,
  );
  assert.equal(h.writes(), 0);
  const response = await post(h.routes.get('/api/nite-search/settings'), { config: invalid, expectedRevision: snapshot.revision });
  assert.equal(response.status, 400);
  const body: any = await response.json();
  assert.equal(body.error.code, 'validation-failed');
  assert.equal(body.error.issues[0].code, 'field.range');
  assert.equal(body.error.issues[0].path, 'maxResults');
  assert.equal(h.writes(), 0);
});

test('a stale revision is a conflict, not a validation problem and not a write', async () => {
  const h = harness();
  await h.apply(defaultConfig());
  const valid = structuredClone(defaultConfig());
  valid.maxResults = 9;
  await assert.rejects(h.tool('search_manage').execute({ action: 'save', config: valid, expectedRevision: 'stale' }, { signal: new AbortController().signal }), /revision conflict/i);
  const response = await post(h.routes.get('/api/nite-search/settings'), { config: valid, expectedRevision: 'stale' });
  assert.equal(response.status, 409);
  const body: any = await response.json();
  assert.equal(body.error.code, 'revision-conflict');
  assert.equal(h.writes(), 0);
});

test('a concurrent save that lands during verification wins and the late save is a conflict', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const h = harness({
    connect: async () => {
      markStarted();
      await gate;
      return { newContext: async () => ({ close: async () => undefined }), close: async () => undefined };
    },
  });
  await h.apply(defaultConfig());
  const snapshot = await snapshotOf(h);
  const route = h.routes.get('/api/nite-search/settings');
  const browserSave = post(route, { config: browserConfig(), expectedRevision: snapshot.revision });
  await started;
  const other = structuredClone(defaultConfig());
  other.maxResults = 10;
  const otherResponse = await post(route, { config: other, expectedRevision: snapshot.revision });
  assert.equal(otherResponse.status, 200, 'the save without browser dependencies completes while the first save is verifying');
  release();
  const browserResponse = await browserSave;
  assert.equal(browserResponse.status, 409, 'the late save must not overwrite the completed one');
  const body: any = await browserResponse.json();
  assert.equal(body.error.code, 'revision-conflict');
  assert.equal(h.writes(), 1);
  assert.equal((h.stored() as any).maxResults, 10, 'the concurrent save remains the saved configuration');
  assert.equal((h.stored() as any).browser.endpoint, '', 'the late browser configuration was not written');
});

test('a save cancelled before it starts writes nothing', async () => {
  const h = harness();
  await h.apply(defaultConfig());
  const snapshot = await snapshotOf(h);
  const config = structuredClone(defaultConfig());
  config.maxResults = 7;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    h.tool('search_manage').execute({ action: 'save', config, expectedRevision: snapshot.revision }, { signal: controller.signal }),
    /cancelled/i,
  );
  assert.equal(h.writes(), 0);
});

test('cancelling during browser verification stops the save before any write', async () => {
  const h = harness({ connect: async () => new Promise(() => undefined) });
  await h.apply(defaultConfig());
  const snapshot = await snapshotOf(h);
  const controller = new AbortController();
  const pending = h.tool('search_manage').execute({ action: 'save', config: browserConfig(), expectedRevision: snapshot.revision }, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(pending, /cancelled/i);
  assert.equal(h.writes(), 0, 'a cancelled verification cannot write configuration');
});

test('a partial saved entry is compared through schema defaults, not raw JSON', async () => {
  const h = harness();
  await h.apply(defaultConfig());
  const snapshot = await snapshotOf(h);
  h.setCurrent({});
  const response = await post(h.routes.get('/api/nite-search/settings'), { config: defaultConfig(), expectedRevision: snapshot.revision });
  assert.equal(response.status, 200, 'filling defaults is not a concurrent edit');
  assert.equal(h.writes(), 1);
});

test('a non-default inherited layer does not create a false conflict; the effective current config is authoritative', async () => {
  const h = harness();
  await h.apply(defaultConfig());
  const snapshot = await snapshotOf(h);
  // SDK patch values replace whole values. The effective entry config is what the running plugin
  // validates; the inherited layer must not be merged back in.
  h.setCurrent({});
  h.setInherited({ maxResults: 9, concurrency: 7 });
  const response = await post(h.routes.get('/api/nite-search/settings'), { config: defaultConfig(), expectedRevision: snapshot.revision });
  assert.equal(response.status, 200);
  assert.equal(h.writes(), 1);
});

test('a partial explicit current config is filled with schema defaults before comparing', async () => {
  const h = harness();
  await h.apply(defaultConfig());
  const snapshot = await snapshotOf(h);
  h.setCurrent({ maxResults: 8 });
  h.setInherited({ maxResults: 9 });
  const response = await post(h.routes.get('/api/nite-search/settings'), { config: defaultConfig(), expectedRevision: snapshot.revision });
  assert.equal(response.status, 200);
  assert.equal(h.writes(), 1);
});

test('an enabled browser dependency refuses the save when the endpoint rejects the token', async () => {
  const h = harness({ connect: async () => { throw new Error('401 Unauthorized'); } });
  await h.apply(defaultConfig());
  h.secrets.set('DSH_SEARCH_BROWSER_TOKEN', 'SAVED_TOKEN');
  const snapshot = await snapshotOf(h);
  const response = await post(h.routes.get('/api/nite-search/settings'), { config: browserConfig(), expectedRevision: snapshot.revision });
  assert.equal(response.status, 400);
  const body: any = await response.json();
  assert.equal(body.error.code, 'browser-verification-failed');
  assert.equal(body.error.issues[0].code, 'browser.authRejected');
  assert.equal(body.error.issues[0].path, 'backends.xiaohongshu.enabled');
  assert.equal(body.error.issues[0].action.target, 'browser.endpoint');
  assert.ok(!JSON.stringify(body).includes('SAVED_TOKEN'), 'a token never reaches the page from a save');
  assert.equal(h.writes(), 0, 'a refused verification never writes configuration');
});

test('a credential-store failure refuses the save with its own structured cause', async () => {
  const h = harness({ tokenReadError: true });
  await h.apply(defaultConfig());
  const snapshot = await snapshotOf(h);
  const response = await post(h.routes.get('/api/nite-search/settings'), { config: browserConfig(), expectedRevision: snapshot.revision });
  assert.equal(response.status, 400);
  const body: any = await response.json();
  assert.equal(body.error.code, 'browser-credential-unavailable');
  assert.match(body.error.message, /token could not be read/);
  assert.ok(!JSON.stringify(body).includes('credential store offline'), 'the raw store error is not echoed');
  assert.equal(h.writes(), 0);
});

test('all browser dependents disabled allows saving an offline browser configuration', async () => {
  const h = harness({ connect: async () => { throw new Error('this must not be called'); } });
  await h.apply(defaultConfig());
  const config = defaultConfig();
  config.browser.endpoint = 'ws://127.0.0.1:9/ws';
  config.backends.xiaohongshu!.enabled = false;
  for (const route of config.pageFetch.routes) if (route.kind === 'browser') route.enabled = false;
  const snapshot = await snapshotOf(h);
  const response = await post(h.routes.get('/api/nite-search/settings'), { config, expectedRevision: snapshot.revision });
  assert.equal(response.status, 200);
  assert.equal(h.writes(), 1, 'the write happens without a probe');
  assert.equal((await response.json()).verified, 0);
});

test('enabled browser dependents are checked once, with the stored token, before writing', async () => {
  const h = harness();
  await h.apply(defaultConfig());
  h.secrets.set('DSH_SEARCH_BROWSER_TOKEN', 'ENDPOINT_TOKEN');
  const config = browserConfig();
  config.pageFetch.routes[1]!.enabled = true;
  config.pageFetch.allowDelegatedFetching = true;
  const snapshot = await snapshotOf(h);
  const response = await post(h.routes.get('/api/nite-search/settings'), { config, expectedRevision: snapshot.revision });
  assert.equal(response.status, 200);
  const body: any = await response.json();
  assert.equal(body.saved, true);
  assert.equal(body.verified, 1, 'one grouped check covers the search backend and the fetch route');
  assert.equal(h.connects.length, 1);
  assert.deepEqual(h.headers[0], { authorization: 'Bearer ENDPOINT_TOKEN' });
  assert.equal(h.writes(), 1);
  assert.equal((h.stored() as any).backends.xiaohongshu.enabled, true);
  assert.equal('credentialRef' in (h.stored() as any).browser, false);
});

test('a browser route without the shared endpoint is rejected by validation and never written', async () => {
  const h = harness();
  await h.apply(defaultConfig());
  const config = defaultConfig();
  config.pageFetch.routes[1]!.enabled = true;
  config.pageFetch.allowDelegatedFetching = true;
  const snapshot = await snapshotOf(h);
  const response = await post(h.routes.get('/api/nite-search/settings'), { config, expectedRevision: snapshot.revision });
  assert.equal(response.status, 400);
  const body: any = await response.json();
  assert.equal(body.error.code, 'validation-failed');
  assert.ok(body.error.issues.some((issue: any) => issue.code === 'pageFetch.route.browserEndpointMissing' && issue.params.kind === 'browser'));
  assert.equal(h.writes(), 0);
});

// --- manual verification ------------------------------------------------------------------------

test('a managed browser check only accepts the saved endpoint and never a credential argument', async () => {
  const h = harness();
  const config = defaultConfig();
  config.browser.endpoint = 'ws://127.0.0.1:3030/ws';
  await h.apply(config);
  const signal = new AbortController().signal;
  const snapshot = await snapshotOf(h);
  assert.ok(!JSON.stringify(snapshot.config).includes('TOKEN'));
  const saved = await h.tool('search_manage').execute({ action: 'verify-browser', endpoint: 'ws://127.0.0.1:3030/ws' }, { signal });
  assert.equal(saved.ok, true);
  assert.equal(h.connects.length, 1);
  await assert.rejects(h.tool('search_manage').execute({ action: 'verify-browser', endpoint: 'ws://attacker.example.com:3030/ws' }, { signal }), /saved shared browser endpoint/);
  await assert.rejects(h.tool('search_manage').execute({ action: 'verify-browser', endpoint: 'ws://127.0.0.1:3030/ws', token: 'x' }, { signal }), /never accepted/);
  await assert.rejects(h.tool('search_manage').execute({ action: 'verify-browser', endpoint: 'https://127.0.0.1:3030/ws' }, { signal }), /saved shared browser endpoint/);
});

test('the settings page may check an unsaved draft endpoint without changing configuration', async () => {
  const h = harness();
  await h.apply(defaultConfig());
  const action = h.routes.get('/api/nite-search/action');
  const response = await action.fetch(new Request('https://localhost/api/nite-search/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'verify-browser', endpoint: 'ws://127.0.0.1:4040/ws' }) }));
  assert.equal(response.status, 200);
  const body: any = await response.json();
  assert.equal(body.ok, true);
  assert.equal(h.connects[0], 'ws://127.0.0.1:4040/ws');
  assert.equal(h.writes(), 0, 'a check never saves');
  const invalid = await action.fetch(new Request('https://localhost/api/nite-search/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'verify-browser', endpoint: 'https://127.0.0.1:4040/ws' }) }));
  assert.equal(invalid.status, 400);
  const invalidBody: any = await invalid.json();
  assert.match(invalidBody.error.message, /WS\(S\)/);
  assert.equal(h.writes(), 0);
});

test('English and Chinese locales carry the same keys, including every issue code', async () => {
  const { readFile } = await import('node:fs/promises');
  const en = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8'));
  const zh = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  const issueKeys = Object.keys(en).filter(key => key.startsWith('issue.'));
  assert.ok(issueKeys.length > 50, `expected the issue catalogue, got ${issueKeys.length}`);
  for (const key of issueKeys) {
    assert.ok(String(en[key]).trim(), `en supplies ${key}`);
    assert.ok(String(zh[key]).trim(), `zh supplies ${key}`);
  }
});

test('the settings client keeps all provider cards and a separate select choice', async () => {
  const { readFile } = await import('node:fs/promises');
  const client = await readFile(new URL('../src/client.tsx', import.meta.url), 'utf8');
  assert.match(client, /const TABS = \['behavior', 'reliability', 'diagnostics', 'backends', 'browser', 'fetch'\]/);
  assert.match(client, /<select id=\{fieldId\('pageFetch\.providerId'\)\}/, 'the fixed provider is chosen with a select');
  assert.doesNotMatch(client, /name="fetch-provider"/, 'provider cards contain no radio choice');
  assert.match(client, /fetchProviders\.map\(\(provider: FetchProviderInfo\)/, 'every provider still has its own configuration card');
  assert.match(client, /id=\{fieldId\('pageFetch\.providerId'\)\}/, 'the fetch provider group is a focus target');
  assert.match(client, /ns-provider-summary/, 'the selected provider has a summary');
  assert.doesNotMatch(client, /id="ns-fetch-provider"/, 'the old dropdown editor is gone');
  assert.equal((client.match(/credentialControl\(def\)/g) || []).length >= 2, true, 'search and fetch cards share the credential control');
  assert.match(client, /sec-browser-dependents/);
  assert.match(client, /pageFetch\.browser\.context/, 'fetch-only browser options stay on the fetch tab');
});

test('browser dependencies are exactly the enabled search browser backends and the fetch browser route', async () => {
  const { collectBrowserDependencies } = await import('@nite07/search-core');
  const config = browserConfig();
  config.pageFetch.routes[1]!.enabled = true;
  config.pageFetch.allowDelegatedFetching = true;
  const dependencies = collectBrowserDependencies(config);
  assert.deepEqual(dependencies.map(dependency => dependency.kind).sort(), ['fetch-browser-route', 'search-backend']);
  assert.ok(dependencies.every(dependency => dependency.endpoint === 'ws://127.0.0.1:3030/ws'));
  assert.deepEqual(catalog.filter(item => item.modes.some(mode => mode.mode === 'browser')).map(item => item.id), ['xiaohongshu']);
  assert.equal(revision(config).length > 0, true);
});
