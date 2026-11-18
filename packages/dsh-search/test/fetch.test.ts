import { test } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apply, defaultConfig } from '../src/index.js';
import { fetchProblemText, fetchReadiness } from '@nite07/search-core';
import { catalog } from '@nite07/search-core';

/** The same host harness the other plugin tests use: routes, tools, credentials and storage. */
function harness() {
  const routes = new Map<string, any>();
  const definitions: Record<string, any> = {};
  let stored: any;
  const secrets = new Map<string, string>();
  const records = new Map();
  const table = { get: (key: string) => records.get(key), entries: () => records.entries(), put: async (key: string, value: any) => { records.set(key, value); } };
  const ctx: any = {
    fiber: { entry: { id: 'test' } },
    effect(fn: any) { return fn(); },
    web: { registerSearchProvider() { return () => {}; } },
    credentials: {
      resolve: async (ref: string) => (secrets.has(ref) ? { value: secrets.get(ref) } : undefined),
      describe: async (ref: string) => ({ configured: secrets.has(ref), writable: true }),
      set: async (ref: string, value: string) => { secrets.set(ref, value); },
      unset: async (ref: string) => { secrets.delete(ref); },
    },
    configEditor: {
      edit: async (_entry: any, fn: any) => { stored = fn({}); },
      configuration: () => [{ entry: { options: { id: 'web' } }, inherited: {}, override: { searchProvider: 'nite-search' } }],
    },
    storageDomain: { open: async () => ({ table: () => table, close: async () => {} }) },
    get(name: string) {
      if (name === 'connection') return { fetch: { register: (route: any) => { routes.set(route.path, route); return async () => {}; } } };
      if (name === 'tools') return { register: (definition: any) => { definitions[definition.name] = definition; return () => {}; } };
    },
  };
  return { ctx, routes, secrets, tool: (name: string) => definitions[name], get stored() { return stored; } };
}

const signal = () => new AbortController().signal;

test('web_extract is registered only when the user turned it on, and hides without affecting anything else', async () => {
  const off = harness();
  await apply(off.ctx, defaultConfig());
  assert.equal(off.tool('web_extract'), undefined, 'the tool is not advertised while the switch is off');
  assert.ok(off.tool('web_search_plus'), 'other tools keep their own switches');
  assert.ok(off.tool('search_manage'));
  const offSnapshot: any = await off.tool('search_manage').execute({ action: 'settings' }, { signal: signal() });
  assert.equal(offSnapshot.config.tools.webExtract, false, 'the switch defaults to off');
  assert.deepEqual(offSnapshot.config.pageFetch.routes.map((route: any) => route.kind), ['http', 'browser', 'provider'], 'fetch configuration stays available while the tool is hidden');

  const on = defaultConfig();
  on.tools.webExtract = true;
  const enabled = harness();
  await apply(enabled.ctx, on);
  const tool = enabled.tool('web_extract');
  assert.ok(tool, 'the tool appears when the switch is on');
  assert.deepEqual(tool.parameters.required, ['url', 'format'], 'both parameters are required: there is no default format');
  assert.deepEqual(tool.parameters.properties.format.enum, ['html', 'markdown']);
  assert.match(tool.description, /untrusted/i);
  assert.match(tool.description, /Markdown for reading/);
  assert.match(tool.description, /HTML for inspecting structure/);
  assert.equal(tool.parameters.properties.routes, undefined, 'route order and provider selection are never call parameters');
});

test('web_extract refuses a missing or unknown format before any request is sent', async () => {
  const config = defaultConfig();
  config.tools.webExtract = true;
  const h = harness();
  await apply(h.ctx, config);
  const tool = h.tool('web_extract');
  for (const format of [undefined, 'text', 'HTML']) {
    await assert.rejects(tool.execute({ url: 'https://example.com', format }, { signal: signal() }), /format/i);
  }
  await assert.rejects(tool.execute({ url: 'ftp://example.com/page', format: 'markdown' }, { signal: signal() }), /http/i);
  await assert.rejects(tool.execute({ format: 'markdown' }, { signal: signal() }), /URL/i);
});

test('the fetch test action is user-triggered and validates its own inputs', async () => {
  const h = harness();
  await apply(h.ctx, defaultConfig());
  const manage = h.tool('search_manage');
  await assert.rejects(manage.execute({ action: 'fetch-test', url: 'https://example.com' }, { signal: signal() }), /format/i);
  await assert.rejects(manage.execute({ action: 'fetch-test', url: 'https://example.com', format: 'pdf' }, { signal: signal() }), /format/i);
  await assert.rejects(manage.execute({ action: 'fetch-test', url: '', format: 'markdown' }, { signal: signal() }), /URL/i);
  await assert.rejects(manage.execute({ action: 'fetch-test', url: 'not a url', format: 'markdown' }, { signal: signal() }), /absolute/i);
});

test('the settings snapshot carries fetch providers and readiness without spending a request', async () => {
  const h = harness();
  const config = defaultConfig();
  await apply(h.ctx, config);
  const snapshot: any = await h.tool('search_manage').execute({ action: 'settings' }, { signal: signal() });
  assert.deepEqual(snapshot.fetch.providers.map((provider: any) => provider.id).sort(), ['exa', 'parallel'], 'only verified fetch providers are offered');
  for (const provider of snapshot.fetch.providers) {
    assert.deepEqual(provider.serves, ['markdown'], 'both providers return native Markdown only');
    assert.deepEqual(provider.modes, ['anonymous']);
    assert.equal(provider.credentialRequired, false);
    assert.ok(provider.endpoint.startsWith('https://'), 'the verified fetch endpoint is reported');
    assert.match(provider.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(snapshot.fetch.providerId, '');
  assert.deepEqual(snapshot.fetch.problems, [], 'the default chain (HTTP only) is ready');
  assert.equal(snapshot.fetch.ready, true);
  const status: any = await h.tool('backend_status').execute({}, { signal: signal() });
  assert.equal(status.fetch.toolExposed, false);
  assert.deepEqual(status.fetch.routes, ['http']);
  assert.match(String(status.text), /web_extract: hidden/);
});

test('readiness reasons are the same keys the page localizes, with English text for the agent', () => {
  const config = defaultConfig();
  const providers = [
    { id: 'exa', title: 'Exa', serves: ['markdown'], modes: ['anonymous'], options: [], endpoint: 'https://mcp.exa.ai/mcp', docs: '', verifiedAt: '2026-11-18', credentialRequired: false, credentialConfigured: true },
  ];
  assert.deepEqual(fetchReadiness(config, providers), []);

  const noRoutes = structuredClone(config);
  for (const route of noRoutes.pageFetch.routes) route.enabled = false;
  assert.deepEqual(fetchReadiness(noRoutes, providers).map(problem => problem.key), ['fetchNoRoutes']);

  const browserRoute = structuredClone(config);
  browserRoute.pageFetch.routes[1]!.enabled = true;
  // The enabled route is the delegated decision itself: readiness asks only for what is still missing.
  assert.deepEqual(fetchReadiness(browserRoute, providers).map(problem => problem.key), ['fetchBrowserNoEndpoint']);
  browserRoute.browser.endpoint = 'ws://127.0.0.1:3030/ws';
  assert.deepEqual(fetchReadiness(browserRoute, providers), [], 'an enabled browser route with an endpoint is ready');

  const providerRoute = structuredClone(config);
  providerRoute.pageFetch.routes[2]!.enabled = true;
  assert.deepEqual(fetchReadiness(providerRoute, providers).map(problem => problem.key), ['fetchProviderMissing']);

  providerRoute.pageFetch.providerId = 'exa';
  providerRoute.backends.exa!.fetch.mode = 'key';
  assert.deepEqual(fetchReadiness(providerRoute, providers).map(problem => problem.key), ['fetchProviderMode']);
  assert.match(fetchProblemText({ key: 'fetchProviderMode', vars: { provider: 'Exa', mode: 'key' } }), /Exa cannot fetch in key/);

  providerRoute.backends.exa!.fetch.mode = 'anonymous';
  const endpointless = providers.map(provider => ({ ...provider, endpoint: '' }));
  assert.deepEqual(fetchReadiness(providerRoute, endpointless).map(problem => problem.key), ['fetchProviderEndpoint']);
});

test('one shared draft keeps search and fetch edits from overwriting each other', async () => {
  const h = harness();
  await apply(h.ctx, defaultConfig());
  const snapshot: any = await h.tool('search_manage').execute({ action: 'settings' }, { signal: signal() });
  const draft = structuredClone(snapshot.config);
  draft.maxResults = 9;
  draft.tools.webExtract = true;
  draft.pageFetch.routes = [draft.pageFetch.routes[2], draft.pageFetch.routes[0], draft.pageFetch.routes[1]];
  draft.pageFetch.providerId = 'exa';
  draft.pageFetch.routes[0].enabled = true;
  draft.pageFetch.routes[0].rules = [{ id: 'keep-me', enabled: true, conditions: [{ type: 'match', field: 'text', operator: 'contains', value: 'boom', caseSensitive: false }] }];
  await h.tool('search_manage').execute({ action: 'save', config: draft, expectedRevision: snapshot.revision }, { signal: signal() });

  const saved = h.stored;
  assert.equal(saved.maxResults, 9, 'the search edit survives');
  assert.equal(saved.tools.webExtract, true, 'the tool switch survives');
  assert.deepEqual(saved.pageFetch.routes.map((route: any) => route.kind), ['provider', 'http', 'browser'], 'the route order survives');
  assert.deepEqual(saved.pageFetch.routes[1].rules, draft.pageFetch.routes[1].rules, 'the response rule set survives unchanged');

  // The harness does not restart the plugin the way a real save does, so the reload is asserted on
  // the saved value through the same migration the host would apply on load.
  const { parseConfig } = await import('@nite07/search-core');
  const reloaded = parseConfig(saved);
  assert.equal(reloaded.maxResults, 9);
  assert.equal(reloaded.tools.webExtract, true);
  assert.deepEqual(reloaded.pageFetch.routes.map(route => route.kind), ['provider', 'http', 'browser']);
});

test('every fetch label the page uses exists in both locales, and the readiness keys are covered', async () => {
  const en = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8'));
  const zh = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8'));
  const keys = [
    'tab.fetch', 'field.tools.webExtract', 'help.tools.webExtract',
    'fetchToolTitle', 'fetchToolHelp', 'fetchReadyTitle', 'fetchReady', 'fetchReadyHelp',
    'fetchRoutesTitle', 'fetchRoutesHelp', 'fetchRoute.http', 'fetchRoute.browser', 'fetchRoute.provider',
    'fetchRouteHelp.http', 'fetchRouteHelp.browser', 'fetchRouteHelp.provider',
    'fetchMoveUp', 'fetchMoveDown', 'fetchEnabled', 'fetchTimeout', 'fetchTimeoutHelp',
    'fetchRules', 'fetchRulesCount', 'fetchRulesHelp', 'fetchAddRule', 'fetchAddCondition', 'fetchRemoveRule',
    'fetchRemoveCondition', 'fetchAddStatusPreset', 'fetchAddCloudflarePreset', 'fetchRestoreDefaultRules', 'fetchPresetsHelp',
    'fetchProviderTitle', 'fetchProviderHelp', 'fetchProviderSelect', 'fetchProviderNone', 'fetchProviderServes',
    'fetchProviderMarkdownOnly', 'fetchMode', 'fetchModeHelp', 'fetchEndpoint', 'fetchEndpointHelp', 'fetchProviderTimeoutHelp',
    'fetchLimitsTitle', 'fetchTestTitle', 'fetchTestHelp', 'fetchTestUrl', 'fetchTestFormat', 'fetchTestResult',
    'fetchFormat.markdown', 'fetchFormat.html', 'fetchConditionType', 'fetchConditionStatuses', 'fetchConditionField',
    'fetchConditionOperator', 'fetchConditionValue', 'fetchConditionCase', 'credentialNotRequired',
    'field.pageFetch.overallTimeoutMs', 'field.pageFetch.maxRedirects', 'field.pageFetch.maxBodyBytes',
    'field.pageFetch.maxOutputChars', 'field.pageFetch.maxRuleScanChars', 'field.pageFetch.allowPrivateNetworks',
    'field.pageFetch.browser.context', 'field.pageFetch.browser.settleMs',
    'field.pageFetch.browser.selectorWait',
  ];
  const problemKeys = ['fetchNoRoutes', 'fetchBrowserNoEndpoint', 'fetchProviderMissing', 'fetchProviderMode', 'fetchProviderEndpoint', 'fetchProviderCredential'];
  const conditionKeys = ['condition.network', 'condition.timeout', 'condition.status', 'condition.api-status', 'condition.error', 'condition.match'];
  const matchFieldKeys = ['matchField.title', 'matchField.html', 'matchField.text', 'matchField.markdown'];
  const matchOperatorKeys = ['matchOperator.contains', 'matchOperator.equals', 'matchOperator.regex'];
  const failureKeys = ['failure.conversion', 'failure.unsupported-content', 'failure.limit'];
  for (const key of [...keys, ...problemKeys.map(item => `problem.${item}`), ...conditionKeys, ...matchFieldKeys, ...matchOperatorKeys, ...failureKeys]) {
    for (const [lang, table] of [['en', en], ['zh', zh]] as const) {
      assert.equal(typeof table[key], 'string', `${lang} supplies ${key}`);
      assert.ok(String(table[key]).trim() !== '', `${lang} supplies a non-empty ${key}`);
    }
  }
});

test('the fetch tab is wired to the shared draft and never to a second store', async () => {
  const client = await readFile(new URL('../src/client.tsx', import.meta.url), 'utf8');
  assert.match(client, /\{tab === 'fetch' &&/);
  assert.match(client, /role="tabpanel" id="panel-fetch"/);
  assert.ok(client.includes("'pageFetch.routes'"), 'the route list is addressed by its configuration path');
  assert.match(client, /update\(fetchRoutesPath/);
  assert.match(client, /update\('pageFetch\.providerId'/);
  assert.ok(!/localStorage[\s\S]{0,400}pageFetch/.test(client), 'fetch settings never live in a second store');
});


test('the fetch test action runs the saved chain against a local page and returns the attempt trace', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<html><head><title>Local</title></head><body><p>served locally</p></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const config = defaultConfig();
    // The target policy is configurable; a local test server needs the explicit opt-in too.
    config.pageFetch.allowPrivateNetworks = true;
    const h = harness();
    await apply(h.ctx, config);
    const result: any = await h.tool('search_manage').execute(
      { action: 'fetch-test', url: `http://127.0.0.1:${port}/local`, format: 'markdown' },
      { signal: signal() },
    );
    assert.equal(result.ok, true);
    assert.equal(result.contentRoute, 'http');
    assert.match(result.content, /served locally/);
    assert.match(result.text, /## Attempts/);
    assert.match(result.text, /http · ok in \d+ms · target 200/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
