import test from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/tools.js';
import { defaultConfig } from '@nite07/search-core';
import type { SearchEngine } from '@nite07/search-core';

const identity = { name: 'websearch-mcp', version: '1.2.3', projectUrl: 'https://example.test/websearch-mcp' };

function configWith(enabled: string[]) {
  const search = defaultConfig();
  for (const id of enabled) search.backends[id]!.enabled = true;
  return { search, credentials: {}, compactByDefault: false, configPath: '/tmp/config.json' };
}

/** A stand-in engine that records the overrides instead of searching. */
function stubEngine() {
  const seen: Array<Record<string, unknown>> = [];
  const engine = {
    async search(input: unknown, _signal: unknown, _only: unknown, overrides: Record<string, unknown>) {
      seen.push({ input, overrides });
      return { sources: [{ url: 'https://example.test/a', title: 'A' }], truncated: false, content: 'note', cached: false, outcomes: [] };
    },
  } as unknown as SearchEngine;
  return { engine, seen };
}

test('web_search passes the strategy through and reports the enabled set', async () => {
  const { engine, seen } = stubEngine();
  const tools = createTools(configWith(['exa', 'reddit']), identity, engine);
  const search = tools.find(tool => tool.name === 'web_search')!;
  const value = await search.call({ query: 'cordis', mode: 'parallel', allBackends: true, exclude: ['reddit'], compact: true, maxResults: 5 }, new AbortController().signal) as Record<string, unknown>;
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.input, { query: 'cordis' });
  const overrides = seen[0]!.overrides as Record<string, unknown>;
  assert.equal(overrides.mode, 'parallel');
  assert.equal(overrides.backends, 'all');
  assert.deepEqual(overrides.exclude, ['reddit']);
  assert.equal(overrides.compact, true);
  assert.equal(overrides.maxResults, 5);
  assert.deepEqual(value.backends, ['exa', 'reddit']);
});

test('compact defaults from the config when the call omits it', async () => {
  const { engine, seen } = stubEngine();
  const config = { ...configWith(['exa']), compactByDefault: true };
  const tools = createTools(config, identity, engine);
  await tools.find(tool => tool.name === 'web_search')!.call({ query: 'x' }, new AbortController().signal);
  assert.equal((seen[0]!.overrides as Record<string, unknown>).compact, true);
  await tools.find(tool => tool.name === 'web_search')!.call({ query: 'x', compact: false }, new AbortController().signal);
  assert.equal((seen[1]!.overrides as Record<string, unknown>).compact, false);
});

test('an empty query is rejected before any request', async () => {
  const { engine, seen } = stubEngine();
  const tools = createTools(configWith(['exa']), identity, engine);
  await assert.rejects(tools.find(tool => tool.name === 'web_search')!.call({ query: '   ' }, new AbortController().signal), /non-empty query/);
  assert.equal(seen.length, 0);
});

test('list_backends reports defaults without enabling anything', async () => {
  const tools = createTools(configWith(['exa']), identity);
  const value = await tools.find(tool => tool.name === 'list_backends')!.call({}, new AbortController().signal) as { backends: Array<Record<string, unknown>>; enabled: string[] };
  assert.deepEqual(value.enabled, ['exa']);
  assert.ok(value.backends.length >= 20);
  assert.ok(value.backends.every(row => 'credentialPresent' in row && 'modes' in row));
});

test('read_thread validates its input before touching a backend', async () => {
  const tools = createTools(configWith(['reddit']), identity);
  await assert.rejects(tools.find(tool => tool.name === 'read_thread')!.call({}, new AbortController().signal), /post URL or a post id/);
  await assert.rejects(tools.find(tool => tool.name === 'read_thread')!.call({ url: 'x', source: 'linkedin' }, new AbortController().signal), /Unknown source/);
});

test('reading an X thread needs session mode and both cookies', async () => {
  const anonymous = configWith(['x']);
  anonymous.search.backends.x!.mode = 'anonymous';
  const tools = createTools(anonymous, identity);
  await assert.rejects(tools.find(tool => tool.name === 'read_thread')!.call({ url: 'https://x.com/a/status/1', source: 'x' }, new AbortController().signal), /anonymous/);

  const session = configWith(['x']);
  session.search.backends.x!.mode = 'session';
  const noCredential = createTools(session, identity);
  await assert.rejects(noCredential.find(tool => tool.name === 'read_thread')!.call({ url: 'https://x.com/a/status/1', source: 'x' }, new AbortController().signal), /authToken/);
});

test('an X thread is rendered with its replies and depth', async () => {
  const config = configWith(['x']);
  config.search.backends.x!.mode = 'session';
  config.credentials.x = '{"authToken":"a","ct0":"c"}';
  const seen: Array<Record<string, unknown>> = [];
  const readers = {
    reddit: (async () => { throw new Error('unused'); }) as unknown as typeof import('@nite07/search-core').fetchRedditThread,
    x: (async (input: Record<string, unknown>) => {
      seen.push(input);
      return {
        post: { id: '999', handle: 'root', text: 'the post body', url: 'https://x.com/root/status/999' },
        replies: [
          { id: '1', handle: 'a', text: 'first reply', depth: 1, url: 'https://x.com/a/status/1', likes: 2 },
          { id: '2', handle: 'b', text: 'nested reply', depth: 2, url: 'https://x.com/b/status/2', likes: 0 },
        ],
        truncated: false,
      };
    }) as unknown as typeof import('@nite07/search-core').fetchXThread,
  };
  const tools = createTools(config, identity, undefined, readers);
  const value = await tools.find(tool => tool.name === 'read_thread')!.call({ url: 'https://x.com/root/status/999', source: 'x', limit: 5, depth: 2 }, new AbortController().signal) as { text: string };
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.limit, 5);
  assert.match(value.text, /the post body/);
  assert.match(value.text, /first reply/);
  assert.match(value.text, /- @b \(0 likes\): nested reply/);
});

test('tool schemas stay honest about their bounds', () => {
  const tools = createTools(configWith([]), identity);
  const search = tools.find(tool => tool.name === 'web_search')!.inputSchema as { properties: Record<string, { maximum?: number; minimum?: number; enum?: string[] }>; required: string[] };
  assert.deepEqual(search.required, ['query']);
  assert.equal(search.properties.maxResults!.maximum, 50);
  assert.deepEqual(search.properties.mode!.enum, ['single', 'parallel']);
  const thread = tools.find(tool => tool.name === 'read_thread')!.inputSchema as { properties: Record<string, { maximum?: number }> };
  assert.equal(thread.properties.depth!.maximum, 8);
  assert.equal(thread.properties.limit!.maximum, 500);
});
