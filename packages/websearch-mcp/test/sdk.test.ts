import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../src/sdk.js';
import { createTools } from '../src/tools.js';
import type { ServerConfig } from '../src/config.js';
import { defaultConfig, SearchEngine } from '@nite07/search-core';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const identity = { name: 'websearch-mcp', version: '9.9.9', projectUrl: 'https://git.nite07.com/nite/search' };

function configWith(enabled: string[]): ServerConfig {
  const search = defaultConfig();
  for (const id of enabled) search.backends[id]!.enabled = true;
  return { search, credentials: {}, compactByDefault: false, configPath: '/tmp/config.json' };
}

function failingEngine(): SearchEngine {
  return {
    async search() {
      throw new Error('backend said no');
    },
  } as unknown as SearchEngine;
}

function engineSaying(text: string): SearchEngine {
  return {
    async search() {
      const sources = [{ url: 'https://example.test/a', title: 'A', backends: ['exa'] }];
      return {
        sources, truncated: false, content: text, cached: false,
        outcomes: [{ backend: 'exa', mode: 'key', ok: true, attempts: 1, durationMs: 1, sources, warnings: [] }],
      };
    },
  } as unknown as SearchEngine;
}

/** A modern-era request carries its revision and capabilities in the _meta envelope. */
const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function harness(engine: SearchEngine, config = configWith(['exa'])) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: Array<Record<string, unknown>> = [];
  clientSide.onmessage = message => inbox.push(message as Record<string, unknown>);
  const handle = serveStdio(() => createServer(createTools(config, identity, engine), identity), { transport: serverSide });
  const send = async (message: Record<string, unknown>): Promise<Record<string, any>> => {
    await clientSide.send(message as never);
    const deadline = Date.now() + 2000;
    while (!inbox.some(reply => reply.id === message.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const index = inbox.findIndex(reply => reply.id === message.id);
    const reply = index >= 0 ? inbox.splice(index, 1)[0] : undefined;
    assert.ok(reply, 'the server answered');
    return reply as Record<string, any>;
  };
  return { send, close: handle.close };
}

test('a modern client discovers the 2026-07-28 revision', async () => {
  const { send, close } = await harness(engineSaying('note'));
  try {
    const reply = await send({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: MODERN_META } });
    const versions = (reply.result.supportedVersions ?? []) as string[];
    assert.ok(versions.includes('2026-07-28'), `advertised ${JSON.stringify(versions)}`);
    const meta = reply.result._meta as Record<string, unknown>;
    assert.equal((meta['io.modelcontextprotocol/serverInfo'] as { name: string }).name, 'websearch-mcp');
  } finally {
    await close();
  }
});

test('a 2025 client still negotiates the handshake', async () => {
  const { send, close } = await harness(engineSaying('note'));
  try {
    const reply = await send({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    assert.equal(reply.result.protocolVersion, '2025-11-25');
    assert.equal(reply.result.serverInfo.version, '9.9.9');
  } finally {
    await close();
  }
});

test('tools/list and tools/call keep the text plus structuredContent framing', async () => {
  const { send, close } = await harness(engineSaying('a report'));
  try {
    const list = await send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const names = (list.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>).map(tool => tool.name);
    assert.deepEqual(names, ['web_search', 'reddit_thread', 'x_thread', 'xiaohongshu_note', 'list_backends', 'search_manage']);
    const searchTool = (list.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>).find(tool => tool.name === 'web_search');
    assert.equal(searchTool?.annotations?.readOnlyHint, true, 'a read-only tool says so');
    const management = (list.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>).find(tool => tool.name === 'search_manage');
    assert.equal(management?.annotations?.readOnlyHint, false);
    assert.equal(management?.annotations?.destructiveHint, true);

    const called = await send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'cordis' }, _meta: MODERN_META } });
    assert.notEqual(called.result.isError, true, 'a successful call is not flagged as an error');
    assert.match(called.result.content[0].text, /example\.test/);
    assert.equal(called.result.structuredContent.sources[0].url, 'https://example.test/a');
  } finally {
    await close();
  }
});

test('optional search strategy survives MCP validation and the response reports provenance', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const sources = [{ url: 'https://example.test/shared', title: 'Shared result', backends: ['exa', 'reddit'] }];
  const engine = {
    async search(input: unknown, _signal: unknown, onlyBackend: unknown, overrides: Record<string, unknown>) {
      seen.push({ input, onlyBackend, overrides });
      return {
        sources, truncated: false, content: 'a report', cached: false,
        outcomes: [
          { backend: 'exa', ok: true, attempts: 2, sources },
          { backend: 'reddit', ok: true, attempts: 1, sources },
        ],
      };
    },
  } as unknown as SearchEngine;
  const { send, close } = await harness(engine, configWith(['exa', 'reddit', 'searxng']));
  try {
    const called = await send({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'web_search', arguments: { query: 'cordis', backends: ['exa', 'reddit'], allBackends: true, exclude: ['searxng'], compact: true, maxResults: 4 }, _meta: MODERN_META },
    });
    assert.notEqual(called.result.isError, true);
    assert.deepEqual(seen, [{
      input: { query: 'cordis' }, onlyBackend: undefined,
      overrides: { backends: ['exa', 'reddit'], exclude: ['searxng'], compact: true, maxResults: 4 },
    }], 'optional selection must not be stripped by the SDK schema');
    assert.deepEqual(called.result.structuredContent, {
      sources, truncated: false, report: 'a report',
      enabledBackends: ['exa', 'searxng', 'reddit'], requestedBackends: ['exa', 'reddit'],
      selectedBackends: ['exa', 'reddit'], executedBackends: ['exa', 'reddit'], backends: ['exa', 'reddit'], cached: false,
      backendStats: [
        { backend: 'exa', ok: true, attempts: 2, sourceCount: 1 },
        { backend: 'reddit', ok: true, attempts: 1, sourceCount: 1 },
      ],
    });
    const text = called.result.content[0].text as string;
    assert.match(text, /enabled[^\n]*exa[^\n]*searxng[^\n]*reddit/i);
    assert.match(text, /requested[^\n]*exa[^\n]*reddit/i);
    assert.match(text, /selected[^\n]*exa[^\n]*reddit/i);
    assert.match(text, /executed[^\n]*exa[^\n]*reddit/i);
    assert.match(text, /cache[^\n]*(?:false|miss|no)/i);
    const resultLine = text.split('\n').find(line => line.includes('https://example.test/shared'))!;
    assert.ok(resultLine, 'a result line contains the URL');
    assert.match(resultLine, /Shared result/);
    assert.match(resultLine, /\[backends: exa, reddit\]/);
  } finally {
    await close();
  }
});

test('a real engine runs only the selected backend and MCP cache hits report no execution', async () => {
  const config = configWith(['exa', 'keenable']);
  config.search.retry.enabled = false;
  config.search.cache.enabled = true;
  config.search.cache.ttlSeconds = 60;
  const urls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    assert.match(url, /keenable/, 'the unselected enabled backend must not receive a request');
    return Response.json({ results: [{ url: 'https://example.test/real', title: 'Real result', content: 'snippet' }] });
  }) as typeof fetch;
  const engine = new SearchEngine(config.search, async () => undefined, fetcher);
  const { send, close } = await harness(engine, config);
  try {
    for (const [id, cached] of [[7, false], [8, true]] as const) {
      const called = await send({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: 'web_search', arguments: { query: 'cordis', backends: ['keenable'], compact: true }, _meta: MODERN_META },
      });
      assert.notEqual(called.result.isError, true);
      const value = called.result.structuredContent;
      assert.deepEqual(value.enabledBackends, ['keenable', 'exa']);
      assert.deepEqual(value.requestedBackends, ['keenable']);
      assert.deepEqual(value.selectedBackends, ['keenable']);
      assert.deepEqual(value.backends, ['keenable']);
      assert.deepEqual(value.executedBackends, cached ? [] : ['keenable']);
      assert.equal(value.cached, cached);
      assert.deepEqual(value.backendStats, [{ backend: 'keenable', ok: true, attempts: cached ? 0 : 1, sourceCount: 1 }]);
      assert.deepEqual(value.sources, [{ url: 'https://example.test/real', title: 'Real result', backends: ['keenable'] }]);
      const text = called.result.content[0].text as string;
      assert.match(text, /\[backends: keenable\]/);
      assert.match(text, cached ? /cache[^\n]*(?:true|hit|yes)/i : /cache[^\n]*(?:false|miss|no)/i);
      assert.equal(urls.length, 1, 'all requests use the injected fetch; the second call is cached');
    }
  } finally {
    await close();
  }
});

test('platform tool schemas reject mixed arguments and remove the old combined reader', async () => {
  const { send, close } = await harness(engineSaying('unused'));
  try {
    for (const [name, args] of [
      ['read_thread', { postId: '1' }],
      ['x_thread', { postId: '1', sort: 'top' }],
      ['x_thread', { postId: '1', limit: 201 }],
      ['reddit_thread', { postId: '1', depth: 0 }],
      ['reddit_thread', { postId: '1', source: 'reddit' }],
    ] as const) {
      const reply = await send({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name, arguments: args, _meta: MODERN_META } });
      assert.ok(reply.error || reply.result?.isError, `${name} rejects an invalid call`);
    }
  } finally { await close(); }
});

test('search_manage saves through MCP and immediately updates enabled backends and gated tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-management-sdk-'));
  const config = configWith(['exa']);
  config.configPath = join(directory, 'config.json');
  await writeFile(config.configPath, JSON.stringify({ search: config.search, credentials: { exa: 'private-test-key' } }));
  const { send, close } = await harness(engineSaying('unused'), config);
  try {
    const call = (id: number, args: Record<string, unknown>) => send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search_manage', arguments: args, _meta: MODERN_META } });
    const settings = await call(30, { action: 'settings' });
    assert.notEqual(settings.result?.isError, true);
    const snapshot = settings.result.structuredContent;
    assert.ok(!JSON.stringify(settings).includes('private-test-key'));
    snapshot.config.backends.exa.enabled = false;
    snapshot.config.backends.reddit.enabled = true;
    snapshot.config.tools.webExtract = true;
    const saved = await call(31, { action: 'save', config: snapshot.config, expectedRevision: snapshot.revision });
    assert.notEqual(saved.result?.isError, true, JSON.stringify(saved));
    const list = await send({ jsonrpc: '2.0', id: 32, method: 'tools/list', params: { _meta: MODERN_META } });
    assert.ok(list.result.tools.some((tool: { name: string }) => tool.name === 'web_extract'));
    const backends = await send({ jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: 'list_backends', arguments: {}, _meta: MODERN_META } });
    assert.deepEqual(backends.result.structuredContent.enabled, ['reddit']);
    const before = await readFile(config.configPath, 'utf8');
    const stale = await call(34, { action: 'save', config: snapshot.config, expectedRevision: snapshot.revision });
    assert.equal(stale.result.isError, true);
    assert.equal(await readFile(config.configPath, 'utf8'), before);
    const malformed = await call(35, { action: 'credential', scope: 'backend', backendId: 'exa', value: 'never-echo-this' });
    assert.equal(malformed.result.isError, true);
    assert.ok(!JSON.stringify(malformed).includes('never-echo-this'));
  } finally { await close(); }
});

test('a tool that throws reports isError with its message', async () => {
  const { send, close } = await harness(failingEngine());
  try {
    const called = await send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'cordis' }, _meta: MODERN_META } });
    assert.equal(called.result.isError, true);
    assert.match(called.result.content[0].text, /backend said no/);
  } finally {
    await close();
  }
});
