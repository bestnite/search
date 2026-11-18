import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../src/sdk.js';
import { createTools } from '../src/tools.js';
import type { ServerConfig } from '../src/config.js';
import { defaultConfig } from '@nite07/search-core';
import type { SearchEngine } from '@nite07/search-core';

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
      return { sources: [{ url: 'https://example.test/a', title: 'A' }], truncated: false, content: text, cached: false, outcomes: [] };
    },
  } as unknown as SearchEngine;
}

const toolsFor = (engine: SearchEngine) => createTools(configWith(['exa']), identity, engine);

/** A modern-era request carries its revision and capabilities in the _meta envelope. */
const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function harness(engine: SearchEngine) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: Array<Record<string, unknown>> = [];
  clientSide.onmessage = message => inbox.push(message as Record<string, unknown>);
  const handle = serveStdio(() => createServer(toolsFor(engine), identity), { transport: serverSide });
  const send = async (message: Record<string, unknown>): Promise<Record<string, any>> => {
    await clientSide.send(message as never);
    const deadline = Date.now() + 2000;
    while (inbox.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const reply = inbox.shift();
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
    assert.deepEqual(names, ['web_search', 'read_thread', 'xiaohongshu_note', 'list_backends']);
    const searchTool = (list.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>).find(tool => tool.name === 'web_search');
    assert.equal(searchTool?.annotations?.readOnlyHint, true, 'a read-only tool says so');

    const called = await send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'cordis' }, _meta: MODERN_META } });
    assert.notEqual(called.result.isError, true, 'a successful call is not flagged as an error');
    assert.match(called.result.content[0].text, /example\.test/);
    assert.equal(called.result.structuredContent.sources[0].url, 'https://example.test/a');
  } finally {
    await close();
  }
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
