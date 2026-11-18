import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { catalog, defaultConfig, fetchReadiness, fetchReadinessProviders } from '@nite07/search-core';
import { createTools } from '../src/tools.js';
import type { ToolDefinition } from '../src/tools.js';
import { createServer } from '../src/sdk.js';
import { snapshot } from '../src/ui/state.js';
import { startUi } from '../src/ui/server.js';
import type { ConfigSource } from '../src/live.js';
import type { ServerConfig } from '../src/config.js';

const identity = { name: 'websearch-mcp', version: '1.2.3', projectUrl: 'https://example.test/websearch-mcp' };

function config(webExtract: boolean): ServerConfig {
  const search = defaultConfig();
  search.tools.webExtract = webExtract;
  return { search, credentials: {}, compactByDefault: false, configPath: '/tmp/config.json' };
}

/** A live source the test can mutate, with the same subscription a watched file gives the server. */
function mutableSource(initial: ServerConfig) {
  let current = initial;
  const listeners = new Set<() => void>();
  let revision = 0;
  const source: ConfigSource = {
    get: () => current,
    revision: () => `r${revision}`,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    set(next: ServerConfig) {
      current = next;
      revision += 1;
      for (const listener of [...listeners]) listener();
    },
    listeners: () => listeners.size,
  };
}

const namesOf = (tools: readonly ToolDefinition[]) => tools.map(tool => tool.name);

test('web_extract is offered, gated and validated like the rest of the surface', async () => {
  const off = createTools(config(false), identity);
  assert.ok(namesOf(off).includes('web_extract'), 'the tool object exists so the server can gate it');
  const offTool = off.find(tool => tool.name === 'web_extract')!;
  assert.equal(offTool.exposed?.(), false, 'it stays unadvertised while the switch is off');

  const on = createTools(config(true), identity);
  const tool = on.find(item => item.name === 'web_extract')!;
  assert.equal(tool.exposed?.(), true);
  assert.deepEqual(tool.inputSchema.required, ['url', 'format']);
  assert.deepEqual((tool.inputSchema.properties as Record<string, { enum?: string[] }>).format!.enum, ['html', 'markdown']);
  assert.match(tool.description, /untrusted/i);
  assert.match(tool.description, /Markdown for reading/);
  assert.match(tool.description, /HTML for inspecting structure/);
  const signal = new AbortController().signal;
  for (const format of [undefined, 'text']) {
    await assert.rejects(tool.call({ url: 'https://example.com', format }, signal), /format/i);
  }
  await assert.rejects(tool.call({ format: 'markdown' }, signal), /URL/i);
  await assert.rejects(tool.call({ url: 'ftp://example.com/page', format: 'markdown' }, signal), /http/i);
});

test('a configuration reload flips exposure without a restart', () => {
  const stateful = mutableSource(config(false));
  const tools = createTools(stateful.source, identity);
  const tool = tools.find(item => item.name === 'web_extract')!;
  const changes: boolean[] = [];
  const unsubscribe = tool.onExposureChange!(() => changes.push(tool.exposed!()));
  assert.equal(tool.exposed!(), false);
  stateful.set(config(true));
  assert.deepEqual(changes, [true], 'the listener the server applies saw the change');
  stateful.set(config(false));
  assert.deepEqual(changes, [true, false]);
  unsubscribe();
  stateful.set(config(true));
  assert.deepEqual(changes, [true, false], 'unsubscribing stops the callback');
});

/** Modern-era request envelope, as the SDK's own tests use. */
const MODERN_META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

async function client() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: Array<Record<string, unknown>> = [];
  clientSide.onmessage = message => inbox.push(message as Record<string, unknown>);
  const stateful = mutableSource(config(false));
  const tools = createTools(stateful.source, identity);
  const handle = serveStdio(() => createServer(tools, identity), { transport: serverSide });
  const send = async (message: Record<string, unknown>): Promise<Record<string, any>> => {
    await clientSide.send(message as never);
    const deadline = Date.now() + 2000;
    while (!inbox.some(item => item.id === message.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const index = inbox.findIndex(item => item.id === message.id);
    assert.ok(index >= 0, `the server answered ${String(message.method)}`);
    return inbox.splice(index, 1)[0] as Record<string, any>;
  };
  return { send, stateful, inbox, close: handle.close };
}

test('tools/list loses and regains web_extract through the protocol list-change path', async () => {
  const h = await client();
  try {
    const first = await h.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const firstNames = (first.result.tools as Array<{ name: string }>).map(tool => tool.name);
    assert.ok(firstNames.includes('web_search'));
    assert.ok(!firstNames.includes('web_extract'), 'the hidden tool is absent instead of refusing execution');

    h.stateful.set(config(true));
    const deadline = Date.now() + 2000;
    while (!h.inbox.some(item => item.method === 'notifications/tools/list_changed') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(h.inbox.some(item => item.method === 'notifications/tools/list_changed'), 'the client is told the list changed');

    const second = await h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const secondNames = (second.result.tools as Array<{ name: string }>).map(tool => tool.name);
    assert.ok(secondNames.includes('web_extract'), 'the enabled tool is advertised');

    h.stateful.set(config(false));
    const third = await h.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const thirdNames = (third.result.tools as Array<{ name: string }>).map(tool => tool.name);
    assert.ok(!thirdNames.includes('web_extract'), 'turning it off hides it again');
    const annotations = (second.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean } }>).find(tool => tool.name === 'web_extract');
    assert.equal(annotations?.annotations?.readOnlyHint, true);
    assert.equal(annotations?.annotations?.openWorldHint, true);
    void MODERN_META;
  } finally {
    await h.close();
  }
});

async function settingsFile(search = defaultConfig()): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wsm-fetch-'));
  const path = join(directory, 'config.json');
  await writeFile(path, `${JSON.stringify({ search, credentials: {}, compactByDefault: false }, null, 2)}\n`);
  return path;
}

test('the settings snapshot reports fetch providers and readiness without a request', async () => {
  const path = await settingsFile();
  const current = await snapshot(path);
  assert.deepEqual(current.fetch.providers.map(provider => provider.id).sort(), ['anysearch', 'deepseek', 'doubao', 'exa', 'keenable', 'linkup', 'open-websearch', 'parallel', 'serpex', 'tavily', 'you']);
  assert.equal(current.fetch.providerId, '');
  assert.equal(current.fetch.ready, true);
  assert.deepEqual(current.fetch.problems, []);
  assert.equal(current.fetch.bounds.rulesPerRoute, 8);
  assert.deepEqual(current.fetch.conditionTypes, ['status', 'api-status', 'network', 'timeout', 'error', 'match']);
  assert.deepEqual((current.fetch.presets.status as { id: string }).id, 'status-errors');

  // A saved file cannot hold this state: validation refuses a browser route without an endpoint.
  // Readiness still names it, so a page that is about to enable the route can explain the refusal.
  const search = defaultConfig();
  // Enabling the route is the delegated decision; the retired switch is gone.
  search.pageFetch.routes[1]!.enabled = true;
  search.browser.endpoint = '';
  const rejected = await snapshot(await settingsFile(search));
  assert.match(String(rejected.loadError), /browser route needs a shared browser endpoint/);
  const rows = fetchReadinessProviders(search, catalog, () => true);
  assert.deepEqual(fetchReadiness(search, rows).map(problem => problem.key), ['fetchBrowserNoEndpoint']);

  const providerSearch = defaultConfig();
  providerSearch.pageFetch.routes[2]!.enabled = true;
  providerSearch.pageFetch.providerId = 'exa';
  const providerReady = await snapshot(await settingsFile(providerSearch));
  assert.equal(providerReady.fetch.ready, true);
  assert.equal(providerReady.fetch.providers.find(provider => provider.id === 'exa')!.endpoint, 'https://mcp.exa.ai/mcp');
});

test('an older settings file is read with fetch defaults and saved with them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wsm-fetch-old-'));
  const path = join(directory, 'config.json');
  const legacy = structuredClone(defaultConfig()) as unknown as Record<string, any>;
  delete legacy.pageFetch;
  delete legacy.tools.webExtract;
  for (const row of Object.values(legacy.backends) as Array<Record<string, unknown>>) delete row.fetch;
  legacy.backends.exa.enabled = true;
  await writeFile(path, `${JSON.stringify({ search: legacy, credentials: {}, compactByDefault: false }, null, 2)}\n`);

  const current = await snapshot(path);
  assert.equal(current.config.tools.webExtract, false);
  assert.equal(current.config.pageFetch.routes.length, 3);
  assert.deepEqual(current.config.pageFetch.routes.map(route => route.enabled), [true, false, false]);
  assert.ok(current.config.backends.exa!.fetch);
  assert.equal(current.loadError, undefined, 'the file is migrated, not reported as broken');
  assert.ok(current.fetch.providers.length >= 2);
});

test('the fetch test endpoint validates its inputs before touching the network', async () => {
  const path = await settingsFile();
  const ui = await startUi({ configPath: path, host: '127.0.0.1', port: 0, version: '0.0.0-test', log: () => undefined });
  const base = `http://127.0.0.1:${ui.port}`;
  const post = (body: unknown) => fetch(`${base}/api/fetch-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const noFormat = await post({ url: 'https://example.com' });
    assert.equal(noFormat.status, 400);
    assert.match(JSON.stringify(await noFormat.json()), /format/i);
    const badFormat = await post({ url: 'https://example.com', format: 'pdf' });
    assert.equal(badFormat.status, 400);
    const noUrl = await post({ format: 'markdown' });
    assert.equal(noUrl.status, 400);
    assert.match(JSON.stringify(await noUrl.json()), /URL/i);
    const settings = await fetch(`${base}/api/settings`);
    const body = (await settings.json()) as Record<string, any>;
    assert.ok(body.fetch, 'the page payload carries the fetch section');
    assert.equal(body.fetch.providers.length, 11);
  } finally {
    await ui.close();
  }
  const text = await readFile(path, 'utf8');
  assert.match(text, /"pageFetch"/);
});


test('the fetch test endpoint runs the saved chain against a local page and returns a trace', async () => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<html><head><title>Local</title></head><body><p>served locally</p></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const search = defaultConfig();
    search.pageFetch.allowPrivateNetworks = true;
    const path = await settingsFile(search);
    const ui = await startUi({ configPath: path, host: '127.0.0.1', port: 0, version: '0.0.0-test', log: () => undefined });
    const base = `http://127.0.0.1:${ui.port}`;
    try {
      const response = await fetch(`${base}/api/fetch-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `http://127.0.0.1:${port}/local`, format: 'markdown' }) });
      const data = (await response.json()) as Record<string, any>;
      assert.equal(data.ok, true);
      assert.equal(data.result.contentRoute, 'http');
      assert.match(data.text, /served locally/);
      assert.match(data.text, /## Attempts/);
    } finally {
      await ui.close();
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('the settings page offers the challenge solver and no retired delegated switch', async () => {
  const page = await readFile(new URL('../src/ui/page.html', import.meta.url), 'utf8');
  assert.match(page, /pageFetch\.browser\.challengeSolver/, 'the solver control is rendered');
  assert.match(page, /challengeSolver: 'Cloudflare 挑战处理'/, 'the Chinese label exists');
  assert.match(page, /challengeSolver: 'Cloudflare challenge handling'/, 'the English label exists');
  assert.doesNotMatch(page, /pageFetch\.allowDelegatedFetching/, 'the retired switch is gone from the page');
});
