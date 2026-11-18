import { test } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apply, defaultConfig } from '../src/index.js';
import { backendCredentialRef, fetchProblemText, fetchReadiness, fetchReadinessProviders } from '@nite07/search-core';
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
  assert.deepEqual(
    snapshot.fetch.providers.map((provider: any) => provider.id).sort(),
    ['anysearch', 'deepseek', 'doubao', 'exa', 'keenable', 'linkup', 'open-websearch', 'parallel', 'serpex', 'tavily', 'you'],
    'only providers with a declared fetch operation are offered',
  );
  const endpoints: Record<string, string> = {
    exa: 'https://mcp.exa.ai/mcp',
    parallel: 'https://mcp.parallel.ai/mcp',
    tavily: 'https://api.tavily.com/extract',
    keenable: 'https://api.keenable.ai/v1/fetch/public',
    anysearch: 'https://api.anysearch.com/v1/extract',
    'open-websearch': 'http://127.0.0.1:3210/fetch-web',
    deepseek: 'https://api.deepseek.com/v1/tools/fetch',
    serpex: 'https://api.serpex.dev/api/crawl',
    linkup: 'https://api.linkup.so/v1/fetch',
    you: 'https://ydc-index.io/v1/extract',
    doubao: 'https://open.feedcoopapi.com/search_api/fetch',
  };
  for (const provider of snapshot.fetch.providers) {
    assert.ok(provider.serves.length > 0, `${provider.id}: the offered formats are stated`);
    assert.ok(provider.modes.length > 0, `${provider.id}: the access modes are stated`);
    // The default mode is the first declared one; a keyless default must not ask for a credential.
    assert.equal(provider.credentialRequired, provider.modes[0] !== 'anonymous', `${provider.id}: credential need follows the default mode`);
    assert.equal(provider.endpoint, endpoints[provider.id], `${provider.id}: the default endpoint is the declared one`);
    assert.match(provider.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
  }
  const fetchProvider = (id: string) => snapshot.fetch.providers.find((provider: any) => provider.id === id)!;
  assert.deepEqual(fetchProvider('exa').serves, ['markdown'], 'Exa returns native Markdown only');
  assert.deepEqual(fetchProvider('tavily').modes, ['anonymous', 'key'], 'Tavily fetches keylessly and with a key');
  assert.deepEqual(fetchProvider('you').modes, ['key'], 'You.com fetch is keyed only');
  assert.deepEqual(fetchProvider('open-websearch').modes, ['anonymous'], 'the self-hosted daemon takes no credential');
  assert.deepEqual(fetchProvider('open-websearch').serves, ['markdown']);
  for (const id of ['serpex', 'linkup', 'you']) {
    assert.deepEqual(fetchProvider(id).serves, ['markdown', 'html'], `${id}: page HTML is declared where the contract returns it`);
  }
  for (const id of ['deepseek', 'keenable', 'anysearch', 'doubao']) {
    assert.deepEqual(fetchProvider(id).serves, ['markdown'], `${id}: Markdown or plain text only, never page HTML`);
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
    { id: 'exa', title: 'Exa', serves: ['markdown'], modes: ['anonymous', 'key'], options: [], endpoint: 'https://mcp.exa.ai/mcp', docs: '', verifiedAt: '2026-11-18', credentialRequired: false, credentialConfigured: true },
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
  // Exa fetches keylessly and with a key; `oauth` is a search mode it never declared for fetching.
  providerRoute.backends.exa!.fetch.mode = 'oauth';
  assert.deepEqual(fetchReadiness(providerRoute, providers).map(problem => problem.key), ['fetchProviderMode']);
  assert.match(fetchProblemText({ key: 'fetchProviderMode', vars: { provider: 'Exa', mode: 'oauth' } }), /Exa cannot fetch in oauth/);

  // A declared keyed mode is ready once the shared credential exists, and not before.
  providerRoute.backends.exa!.fetch.mode = 'key';
  const unkeyed = providers.map(provider => ({ ...provider, credentialRequired: true, credentialConfigured: false }));
  assert.deepEqual(fetchReadiness(providerRoute, unkeyed).map(problem => problem.key), ['fetchProviderCredential']);
  const keyed = providers.map(provider => ({ ...provider, credentialRequired: true, credentialConfigured: true }));
  assert.deepEqual(fetchReadiness(providerRoute, keyed), [], 'a keyed mode with a stored key is ready');

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
    'fetchEvidenceLive', 'fetchEvidenceDocumented', 'fetchEvidenceBadge', 'fetchModeDocumentedOnly', 'fetchCredentialShared',
    'fetchCredentialTitle', 'fetchCredentialHelp', 'fetchCredentialValue',
    'fetchModeCosts', 'fetchModeCostsHelp', 'fetchReadinessProvider',
    'fetchLimitsTitle', 'fetchTestTitle', 'fetchTestHelp', 'fetchTestUrl', 'fetchTestFormat', 'fetchTestResult',
    'fetchFormat.markdown', 'fetchFormat.html', 'fetchConditionType', 'fetchConditionStatuses', 'fetchConditionField',
    'fetchConditionOperator', 'fetchConditionValue', 'fetchConditionCase', 'credentialNotRequired',
    'field.pageFetch.overallTimeoutMs', 'field.pageFetch.maxRedirects', 'field.pageFetch.maxBodyBytes',
    'field.pageFetch.maxOutputChars', 'field.pageFetch.maxRuleScanChars', 'field.pageFetch.allowPrivateNetworks',
    'field.pageFetch.browser.context', 'field.pageFetch.browser.settleMs',
    'field.pageFetch.browser.selectorWait', 'field.pageFetch.browser.challengeSolver',
    'help.pageFetch.browser.challengeSolver', 'challengeSolver.off', 'challengeSolver.auto',
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

test('each fetch mode states its cost before it is enabled, and the readiness card repeats the selected provider warning', async () => {
  const client = await readFile(new URL('../src/client.tsx', import.meta.url), 'utf8');
  assert.match(client, /def\.fetch\?\.modeConstraints/, 'the card reads the per-mode cost metadata');
  assert.match(client, /t\('fetchModeCostsHelp'\)/, 'the cost block explains itself');
  assert.match(client, /\{t\('fetchModeCosts'\)\}/, 'the selected mode cost is labelled on the readiness card');
  assert.match(client, /tr\('fetchReadinessProvider'/, 'readiness names the selected provider and mode');
  assert.match(client, /selectedFetchProvider\.notes && <p className="ns-muted">\{selectedFetchProvider\.notes\[lang\]\}/, 'the selected provider note is visible before a test');
  const en = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8'));
  const zh = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8'));
  for (const [lang, table] of [['en', en], ['zh', zh]] as const) {
    for (const key of ['fetchModeCosts', 'fetchModeCostsHelp', 'fetchReadinessProvider']) {
      assert.equal(typeof table[key], 'string', `${lang} supplies ${key}`);
      assert.ok(String(table[key]).trim() !== '', `${lang} supplies a non-empty ${key}`);
    }
  }
  assert.match(en.fetchModeCostsHelp, /before the mode is enabled/i);
  assert.match(zh.fetchModeCostsHelp, /启用之前/);
});

test('the status read judges a backend credential over every keyed mode it can run', async () => {
  const h = harness();
  const config = defaultConfig();
  // You.com searches keylessly and fetches with a key: the key is needed by the fetch mode, so the
  // read must not report "not required" from the search mode alone.
  config.backends.you!.mode = 'anonymous';
  config.backends.you!.fetch.mode = 'key';
  config.backends.you!.fetch.endpoint = '';
  await apply(h.ctx, config);

  const manage = h.tool('search_manage');
  const missing: any = await h.tool('backend_status').execute({ backend: 'you' }, { signal: signal() });
  assert.equal(missing.credential, 'missing', 'the key the fetch mode needs is reported');
  assert.match(missing.text, /fetch: key \(needs the stored key\)/, 'the read names the fetch mode and its key');

  // Providers whose every mode is keyless stay "not required".
  const openWeb: any = await h.tool('backend_status').execute({ backend: 'open-websearch' }, { signal: signal() });
  assert.equal(openWeb.credential, 'not-required');
  const keenable: any = await h.tool('backend_status').execute({ backend: 'keenable' }, { signal: signal() });
  assert.equal(keenable.credential, 'not-required');

  // An enabled keyless-search backend with a keyed fetch is reported by the list view, once, and the
  // fetch readiness form is still part of the same answer.
  const withYouEnabled = structuredClone(config);
  withYouEnabled.backends.you!.enabled = true;
  const h2 = harness();
  await apply(h2.ctx, withYouEnabled);
  const list: any = await h2.tool('backend_status').execute({}, { signal: signal() });
  const row = list.enabled.find((item: any) => item.id === 'you');
  assert.equal(row.credential, 'missing');
  assert.equal(row.credentialUsedBy, 'fetch', 'the reason the key is reported is stated');
  assert.ok(list.problems.some((problem: string) => /you fetches in key mode and no credential is stored/.test(problem)), 'the missing fetch key is a stated problem');
  assert.deepEqual(Object.keys(list.fetch).sort(), ['problems', 'providerId', 'providerServes', 'ready', 'routes', 'toolExposed'], 'fetch readiness is still reported');
  const searchProblem = list.problems.some((problem: string) => /you is enabled in anonymous mode but no credential/.test(problem));
  assert.equal(searchProblem, false, 'a key only the fetch needs is never reported as a search failure');

  // Storing the key flips the same read to present.
  await manage.execute({ action: 'credential', backendId: 'you', value: 'ydc-key' }, { signal: signal() });
  const present: any = await h.tool('backend_status').execute({ backend: 'you' }, { signal: signal() });
  assert.equal(present.credential, 'present');
  assert.ok(h.secrets.has(backendCredentialRef('you')), 'the same fixed credential reference is used');
});

test('the snapshot carries the doubao key-type caveat where the provider is listed', async () => {
  const h = harness();
  await apply(h.ctx, defaultConfig());
  const snapshot: any = await h.tool('search_manage').execute({ action: 'settings' }, { signal: signal() });
  const doubao = snapshot.fetch.providers.find((provider: any) => provider.id === 'doubao');
  assert.ok(doubao, 'doubao is offered as a fetch provider');
  assert.match(doubao.notes.en, /pay-as-you-go/i, 'the English note says which key type fetches');
  assert.match(doubao.notes.en, /subscription/i);
  assert.match(doubao.notes.zh, /按量后付费/);
  assert.match(doubao.notes.zh, /订阅套餐/);
});

test('the fetch provider card is never opened by selection, and shows the selection through its badge', async () => {
  const client = await readFile(new URL('../src/client.tsx', import.meta.url), 'utf8');
  // Selection may never drive the details element: choosing a provider in the select must not unfold
  // its card, so the card carries no `open` attribute at all and only a user click opens it.
  assert.doesNotMatch(client, /open=\{/, 'no card is opened from state');
  assert.doesNotMatch(client, /ns-provider-card[^>]*open/, 'the provider card has no open prop');
  assert.match(client, /<details className="ns-card ns-backend ns-provider-card" key=\{`fetch-\$\{def\.id\}`\}>/, 'the provider card is a plain details element');
  assert.match(client, /selected \? t\('fetchProviderSelected'\) : t\('fetchProviderNotSelected'\)/, 'the selected state stays visible on the badge');
  assert.match(client, /ns-mode-evidence/, 'each mode carries its own evidence marker');
  assert.match(client, /modeEvidence\?\.evidence === 'documented'/, 'a documented-only mode is called out');
  // The warning has to be explicit: a documented-only mode must never read as if it had been checked.
  assert.match(client, /t\('fetchEvidenceBadge'\)/, 'the documented mode carries a visible badge, not only a tooltip');
  const en = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8'));
  const zh = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8'));
  assert.match(en.fetchModeDocumentedOnly, /no call with a real API key was made/i);
  assert.match(en.fetchModeDocumentedOnly, /not live-verified/i);
  assert.match(zh.fetchModeDocumentedOnly, /没有用真实 API Key 发起过调用/);
  assert.match(zh.fetchModeDocumentedOnly, /不是实测验证/);
  assert.match(en.fetchEvidenceDocumented, /Documented only, no live call/);
  assert.match(zh.fetchEvidenceDocumented, /仅文档核实，未实测/);
  assert.match(en.fetchEvidenceBadge, /^documented$/);
  assert.match(zh.fetchEvidenceBadge, /文档/);
});

test('one credential control serves a keyed search mode or a keyed fetch mode, and is focused directly', async () => {
  const client = await readFile(new URL('../src/client.tsx', import.meta.url), 'utf8');
  // A keyed fetch with keyless search must be enterable: the search card renders the control for
  // either operation that needs the key, and the fetch card repeats it inline.
  assert.match(client, /fetchModeNeedsCredential\(\{ fetchMode: fetchModeOf\(def\), fetchModes: def\.fetch\?\.modes \?\? \[\] \}\)/, 'only a declared keyed fetch mode asks for the key');
  assert.match(client, /needsCredentialControl\(\{ searchMode: searchModeOf\(def\), fetchMode: fetchModeOf\(def\), fetchModes: def\.fetch\?\.modes \?\? \[\] \}\)/, 'the render decision is the tested presenter helper');
  assert.match(client, /\{needsCredential\(def\) && !locked && credentialControl\(def\)\}/, 'the control is not gated on the search mode alone');
  assert.match(client, /\{credentialControl\(def, 'fetch'\)\}/, 'the fetch card renders the same control inline');
  assert.match(client, /credentialFieldId\(def\.id\)/, 'the search card keeps its own input id');
  assert.match(client, /fetchCredentialFieldId\(def\.id\)/, 'the fetch card input has its own id');
  assert.match(client, /anonymousSearchKeyedFetch/, 'keyless search and keyed fetch are described per mode, not contradicted');
  assert.match(client, /credentialForFetch/, 'the control says when only the fetch mode uses the key');
  assert.match(client, /provider\.modes\.map\(mode => modeChip\([^;]+evidenceLabel\(def, mode\)\)/, 'the collapsed summary retains evidence in its tooltip');
  assert.match(client, /ns-mode-evidence[\s\S]*documented \? ` · \$\{t\('fetchEvidenceBadge'\)\}`/, 'the expanded card visibly names a documented-only mode');
  assert.match(client, /selectedFetchEvidence/, 'the selected provider summary names the evidence of the selected mode');
});

test('the fetch card repeats the credential control, and both inputs share one store and one write', async () => {
  const client = await readFile(new URL('../src/client.tsx', import.meta.url), 'utf8');
  // The inline control is gated on the saved fetch mode, never on "the search mode is not anonymous".
  assert.match(client, /\{fetchNeedsKey\(def\) && <div className="ns-credential-shared">/, 'the inline control follows the saved fetch mode');
  assert.match(client, /const inputId = onFetch \? fetchCredentialFieldId\(def\.id\) : credentialFieldId\(def\.id\);/, 'one component picks the id from where it is rendered');
  assert.match(client, /<input id=\{inputId\} type="password" autoComplete="new-password" aria-describedby=\{`\$\{inputId\}-why`\} value=\{secrets\[def\.id\] \|\| ''\}/, 'both inputs share the masking semantics and the stored/unset state');
  assert.match(client, /t\(onFetch \? 'fetchCredentialTitle' : 'credentialTitle'\)/, 'the fetch card has its own title');
  assert.match(client, /t\(onFetch \? 'fetchCredentialValue' : 'credentialValue'\)/, 'the fetch card has its own label');
  assert.match(client, /t\(onFetch \? 'fetchCredentialHelp' : 'credentialHelp'\)/, 'the fetch card has its own help');
  // One write path: the same action and the same backend id, whichever input is used.
  assert.equal((client.match(/credential\(def\.id, false\)/g) || []).length, 1, 'both inputs share the one save action');
  assert.equal((client.match(/request\('credential', \{ backendId: id,/g) || []).length, 1, 'the page has one backend-credential write');
  assert.match(client, /request\('credential', \{ backendId: id,/, 'the one write names the backend, not a second credential');
  assert.doesNotMatch(client, /backendCredentialRef|credentialRef\b/, 'the page invents no second credential name');
  // The shared buffer is cleared after a success and after a failure, so neither input keeps the value.
  assert.equal((client.match(/\[id\]: ''/g) || []).length, 2, 'the shared buffer is cleared on success and on failure');
  // A missing fetch key is entered in place: the readiness warning focuses the inline input.
  assert.match(client, /problem\.key === 'fetchProviderCredential' && selectedFetchProvider && <button[\s\S]{0,160}focusPath\(fetchCredentialFieldId\(selectedFetchProvider\.id\)\)/, 'the readiness credential problem links to the inline fetch input');
  assert.match(client, /disabled=\{!!pending \|\| disabled \|\| !secrets\[def\.id\]\}/, 'a save in progress disables both copies instead of double-submitting');
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


test('a keyed fetch with keyless search is saveable and uses the provider\'s one credential reference', async () => {
  const h = harness();
  await apply(h.ctx, defaultConfig());
  const manage = h.tool('search_manage');
  const snapshot: any = await manage.execute({ action: 'settings' }, { signal: signal() });
  const draft = structuredClone(snapshot.config);
  draft.pageFetch.providerId = 'exa';
  draft.pageFetch.routes[2].enabled = true;
  draft.backends.exa.fetch.mode = 'key';
  draft.backends.exa.fetch.endpoint = '';
  assert.equal(draft.backends.exa.mode, 'anonymous', 'the search row stays keyless');
  // Saving is allowed before a key exists: the mode is a valid configuration, not a validation error.
  await manage.execute({ action: 'save', config: draft, expectedRevision: snapshot.revision }, { signal: signal() });
  const saved = h.stored;
  assert.equal(saved.backends.exa.mode, 'anonymous');
  assert.equal(saved.backends.exa.fetch.mode, 'key');
  assert.equal(saved.backends.exa.fetch.endpoint, '', 'an empty endpoint keeps the mode\'s declared REST endpoint');

  // Readiness says "credential missing" until the key is stored, and the key is the search-provider
  // credential: one fixed reference, no fetch-only secret.
  const providers = fetchReadinessProviders(saved, catalog, id => h.secrets.has(backendCredentialRef(id)));
  assert.deepEqual(fetchReadiness(saved, providers).map(problem => problem.key), ['fetchProviderCredential']);
  await manage.execute({ action: 'credential', backendId: 'exa', value: 'exa-key' }, { signal: signal() });
  assert.equal(h.secrets.get(backendCredentialRef('exa')), 'exa-key');
  const after: any = await manage.execute({ action: 'settings' }, { signal: signal() });
  assert.equal(after.credentials.exa.configured, true);
  assert.deepEqual(fetchReadiness(saved, fetchReadinessProviders(saved, catalog, id => h.secrets.has(backendCredentialRef(id)))), [], 'a keyed fetch with a stored key is ready');
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
