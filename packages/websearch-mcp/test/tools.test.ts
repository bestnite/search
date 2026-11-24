import test from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../src/tools.js';
import type { ServerConfig } from '../src/config.js';
import { defaultConfig } from '@nite07/search-core';
import type { SearchEngine } from '@nite07/search-core';

const identity = { name: 'websearch-mcp', version: '1.2.3', projectUrl: 'https://example.test/websearch-mcp' };

function configWith(enabled: string[]): ServerConfig {
  const search = defaultConfig();
  for (const id of enabled) search.backends[id]!.enabled = true;
  const credentials: Record<string, string> = {};
  return { search, credentials, compactByDefault: false, configPath: '/tmp/config.json' };
}

/** A stand-in engine that records the overrides instead of searching. */
function stubEngine(result: Record<string, unknown> = {}) {
  const seen: Array<Record<string, unknown>> = [];
  const engine = {
    async search(input: unknown, _signal: unknown, _only: unknown, overrides: Record<string, unknown>) {
      seen.push({ input, overrides });
      const sources = [{ url: 'https://example.test/a', title: 'A', backends: ['exa'] }];
      return {
        sources, truncated: false, content: 'note', cached: false,
        outcomes: [{ backend: 'exa', mode: 'key', ok: true, attempts: 1, durationMs: 1, sources, warnings: [] }],
        ...result,
      };
    },
  } as unknown as SearchEngine;
  return { engine, seen };
}

test('web_search passes all plus exclusions through and distinguishes enabled from selected backends', async () => {
  const { engine, seen } = stubEngine();
  const tools = createTools(configWith(['exa', 'reddit']), identity, engine);
  const search = tools.find(tool => tool.name === 'web_search')!;
  const value = await search.call({ query: 'cordis', allBackends: true, exclude: ['reddit'], compact: true, maxResults: 5 }, new AbortController().signal) as Record<string, unknown>;
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.input, { query: 'cordis' });
  const overrides = seen[0]!.overrides as Record<string, unknown>;
  assert.equal(overrides.mode, undefined, 'the saved mode is gone; the call decides');
  assert.equal(overrides.backends, 'all');
  assert.deepEqual(overrides.exclude, ['reddit']);
  assert.equal(overrides.compact, true);
  assert.equal(overrides.maxResults, 5);
  assert.deepEqual(value.enabledBackends, ['exa', 'reddit']);
  assert.equal(value.requestedBackends, 'all');
  assert.deepEqual(value.selectedBackends, ['exa']);
  assert.deepEqual(value.executedBackends, ['exa']);
  assert.deepEqual(value.backends, ['exa'], 'the compatibility alias names the selected set, not the enabled set');
  assert.equal(value.cached, false);
  assert.deepEqual(value.backendStats, [{ backend: 'exa', ok: true, attempts: 1, sourceCount: 1 }]);
  assert.deepEqual(value.sources, [{ url: 'https://example.test/a', title: 'A', backends: ['exa'] }]);
});

test('an explicit backend array wins over allBackends and preserves exclusions', async () => {
  const { engine, seen } = stubEngine();
  const search = createTools(configWith(['exa', 'reddit']), identity, engine).find(tool => tool.name === 'web_search')!;
  const value = await search.call({ query: 'cordis', backends: ['exa', 'reddit'], allBackends: true, exclude: ['reddit'] }, new AbortController().signal) as Record<string, unknown>;
  assert.deepEqual(seen[0]!.overrides, { backends: ['exa', 'reddit'], exclude: ['reddit'], compact: false });
  assert.deepEqual(value.requestedBackends, ['exa', 'reddit'], 'the requested set is not rewritten to the resolved subset');
  assert.deepEqual(value.selectedBackends, ['exa']);
});

test('omitted selection and allBackends false both report the default all request', async () => {
  const { engine, seen } = stubEngine();
  const search = createTools(configWith(['exa', 'reddit']), identity, engine).find(tool => tool.name === 'web_search')!;
  for (const args of [{ query: 'cordis' }, { query: 'cordis', allBackends: false }]) {
    const value = await search.call(args, new AbortController().signal) as Record<string, unknown>;
    assert.equal(value.requestedBackends, 'all');
    assert.deepEqual(value.enabledBackends, ['exa', 'reddit']);
    assert.deepEqual(value.selectedBackends, ['exa'], 'selection is taken from outcomes, not inferred from the request');
  }
  assert.ok(seen.every(call => (call.overrides as Record<string, unknown>).backends === undefined));
});

test('zero-attempt failures are selected but not executed and retain their errors', async () => {
  const error = { kind: 'configuration', message: 'API-key mode selected but credential is missing.' };
  const { engine } = stubEngine({
    outcomes: [
      { backend: 'reddit', ok: false, attempts: 0, sources: [], error },
      { backend: 'exa', ok: true, attempts: 2, sources: [{ url: 'https://example.test/a' }, { url: 'https://example.test/b' }] },
    ],
  });
  const search = createTools(configWith(['exa', 'reddit']), identity, engine).find(tool => tool.name === 'web_search')!;
  const value = await search.call({ query: 'cordis' }, new AbortController().signal) as Record<string, unknown>;
  assert.deepEqual(value.selectedBackends, ['reddit', 'exa'], 'outcome order is preserved');
  assert.deepEqual(value.backends, ['reddit', 'exa']);
  assert.deepEqual(value.executedBackends, ['exa']);
  assert.deepEqual(value.backendStats, [
    { backend: 'reddit', ok: false, attempts: 0, sourceCount: 0, error },
    { backend: 'exa', ok: true, attempts: 2, sourceCount: 2 },
  ]);
});

test('cache hits preserve selection and source provenance without claiming upstream attempts', async () => {
  const sources = [{ url: 'https://example.test/a', title: 'A', backends: ['exa', 'reddit'] }];
  const { engine } = stubEngine({
    cached: true, sources,
    outcomes: [
      { backend: 'exa', ok: true, attempts: 3, sources },
      { backend: 'reddit', ok: true, attempts: 1, sources },
    ],
  });
  const search = createTools(configWith(['exa', 'reddit']), identity, engine).find(tool => tool.name === 'web_search')!;
  const value = await search.call({ query: 'cordis', backends: ['exa', 'reddit'] }, new AbortController().signal) as Record<string, unknown>;
  assert.equal(value.cached, true);
  assert.deepEqual(value.selectedBackends, ['exa', 'reddit']);
  assert.deepEqual(value.backends, ['exa', 'reddit']);
  assert.deepEqual(value.executedBackends, []);
  assert.deepEqual(value.backendStats, [
    { backend: 'exa', ok: true, attempts: 0, sourceCount: 1 },
    { backend: 'reddit', ok: true, attempts: 0, sourceCount: 1 },
  ]);
  assert.deepEqual(value.sources, sources);
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

test('reddit_thread validates its input before touching a backend', async () => {
  const tools = createTools(configWith(['reddit']), identity);
  await assert.rejects(tools.find(tool => tool.name === 'reddit_thread')!.call({}, new AbortController().signal), /post URL or a post id/);
  await assert.rejects(tools.find(tool => tool.name === 'reddit_thread')!.call({ url: 'x', source: 'linkedin' }, new AbortController().signal), /Unknown thread argument/);
});

test('reading an X thread needs session mode and both cookies', async () => {
  const anonymous = configWith(['x']);
  anonymous.search.backends.x!.mode = 'anonymous';
  const tools = createTools(anonymous, identity);
  await assert.rejects(tools.find(tool => tool.name === 'x_thread')!.call({ url: 'https://x.com/a/status/1' }, new AbortController().signal), /anonymous/);

  const session = configWith(['x']);
  session.search.backends.x!.mode = 'session';
  const noCredential = createTools(session, identity);
  await assert.rejects(noCredential.find(tool => tool.name === 'x_thread')!.call({ url: 'https://x.com/a/status/1' }, new AbortController().signal), /authToken/);
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
  const value = await tools.find(tool => tool.name === 'x_thread')!.call({ url: 'https://x.com/root/status/999', limit: 5, depth: 2 }, new AbortController().signal) as { text: string };
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.limit, 5);
  assert.match(value.text, /the post body/);
  assert.match(value.text, /first reply/);
  assert.match(value.text, /- @b \(0 likes\): nested reply/);
});

test('tool schemas stay honest about their bounds', () => {
  const tools = createTools(configWith([]), identity);
  const search = tools.find(tool => tool.name === 'web_search')!.inputSchema as { properties: Record<string, { maximum?: number; minimum?: number; enum?: string[]; description?: string }>; required: string[] };
  assert.deepEqual(search.required, ['query']);
  assert.equal(search.properties.maxResults!.maximum, 50);
  assert.equal(search.properties.mode, undefined, 'the backends array is the strategy, so there is no mode argument');
  assert.equal(search.properties.backend, undefined, 'one backend is backends:["id"], not its own argument');
  assert.match(String(search.properties.backends!.description), /several run in parallel/);
  const thread = tools.find(tool => tool.name === 'reddit_thread')!.inputSchema as { properties: Record<string, { maximum?: number }> };
  assert.equal(thread.properties.depth!.maximum, 8);
  assert.equal(thread.properties.limit!.maximum, 500);
  const x = tools.find(tool => tool.name === 'x_thread')!.inputSchema as { properties: Record<string, { minimum?: number; maximum?: number }> };
  assert.equal(x.properties.limit!.maximum, 200);
  assert.equal(x.properties.depth!.minimum, 0);
  assert.equal(x.properties.sort, undefined);
  assert.equal(x.properties.source, undefined);
  assert.equal(thread.properties.source, undefined);
  assert.equal(tools.some(tool => tool.name === 'read_thread'), false);
});

test('platform readers reject wrong options, bounds, disabled backends and non-session X modes before requests', async () => {
  const config = configWith(['reddit', 'x']);
  let calls = 0;
  const readers = { reddit: (async () => { calls++; }) as never, x: (async () => { calls++; }) as never };
  const tools = createTools(config, identity, undefined, readers);
  const reddit = tools.find(tool => tool.name === 'reddit_thread')!;
  const x = tools.find(tool => tool.name === 'x_thread')!;
  const signal = new AbortController().signal;
  for (const args of [{ postId: '1', depth: 0 }, { postId: '1', limit: 501 }, { postId: '1', sort: 'bad' }, { postId: '1', source: 'x' }]) await assert.rejects(reddit.call(args, signal));
  for (const args of [{ postId: '1', depth: -1 }, { postId: '1', limit: 201 }, { postId: '1', sort: 'top' }, { postId: '1', source: 'x' }]) await assert.rejects(x.call(args, signal));
  config.search.backends.reddit!.enabled = false;
  await assert.rejects(reddit.call({ postId: '1' }, signal), /disabled/);
  config.search.backends.x!.enabled = false;
  await assert.rejects(x.call({ postId: '1' }, signal), /disabled/);
  config.search.backends.x!.enabled = true;
  config.search.backends.x!.mode = 'key';
  await assert.rejects(x.call({ postId: '1' }, signal), /session mode/);
  assert.equal(calls, 0);
});


test('Reddit and X readers use the same fixed-name environment-first credentials as search',async()=>{
 const oldX=process.env.DSH_SEARCH_X_KEY;const oldReddit=process.env.DSH_SEARCH_REDDIT_KEY;
 process.env.DSH_SEARCH_X_KEY='{"authToken":"env-auth","ct0":"env-csrf"}';
 process.env.DSH_SEARCH_REDDIT_KEY='{"clientId":"env-id","clientSecret":"env-secret"}';
 const config=configWith(['reddit','x']);config.search.backends.reddit!.mode='oauth';
 config.credentials={reddit:'{"clientId":"file-id","clientSecret":"file-secret"}',x:'{"authToken":"file-auth","ct0":"file-csrf"}'};
 const seen:Record<string,unknown>[]=[];
 const readers={
  reddit:(async (_input:unknown,options:Record<string,unknown>)=>{seen.push(options);return {post:{title:'test',author:'a',score:1,url:'https://reddit.com/comments/1'},comments:[],truncated:false};}) as unknown as typeof import('@nite07/search-core').fetchRedditThread,
  x:(async (_input:unknown,options:Record<string,unknown>)=>{seen.push(options);return {post:{text:'test',url:'https://x.com/a/status/1'},replies:[],truncated:false};}) as unknown as typeof import('@nite07/search-core').fetchXThread,
 };
 try{
   config.search.backends.x!.mode='session';
   const tools=createTools(config,identity,undefined,readers);
   await tools.find(tool=>tool.name==='reddit_thread')!.call({postId:'1'},new AbortController().signal);
   await tools.find(tool=>tool.name==='x_thread')!.call({postId:'1'},new AbortController().signal);
   assert.deepEqual(seen[0]!.credentials,{clientId:'env-id',clientSecret:'env-secret'});assert.deepEqual(seen[1]!.credentials,{authToken:'env-auth',ct0:'env-csrf'});
 }finally{if(oldX===undefined)delete process.env.DSH_SEARCH_X_KEY;else process.env.DSH_SEARCH_X_KEY=oldX;if(oldReddit===undefined)delete process.env.DSH_SEARCH_REDDIT_KEY;else process.env.DSH_SEARCH_REDDIT_KEY=oldReddit;}
});

/** A Xiaohongshu note reader that records what it was asked for. */
function stubNotes(comments: Array<Record<string, unknown>> = []) {
  const seen: Array<Record<string, unknown>> = [];
  const note = {
    id: 'n1', title: '标题', desc: '正文内容', author: '作者', likes: '10', collects: '2', comments: '3', shares: '1',
    tags: ['标签'], imageUrls: [], url: 'https://www.xiaohongshu.com/explore/n1',
  };
  return {
    seen,
    // One reader, because the note and its comment page are one transaction in the real client.
    readers: {
      read: (async (input: Record<string, unknown>) => {
        seen.push({ kind: 'note', ...input });
        return {
          note,
          ...(input.withComments === true ? { comments: { comments, hasMore: true } } : {}),
        };
      }) as never,
    },
  };
}

function xhsConfig(): ServerConfig {
  const config = configWith(['xiaohongshu']);
  config.search.backends.xiaohongshu!.mode = 'browser';
  config.search.browser.endpoint = 'ws://127.0.0.1:3000/ws';
  return config;
}

test('xiaohongshu_note is registered and reads a note without touching the search engine', async () => {
  const { engine } = stubEngine();
  const { readers, seen } = stubNotes();
  const tools = createTools(xhsConfig(), identity, engine, undefined, readers);
  const tool = tools.find(item => item.name === 'xiaohongshu_note');
  assert.ok(tool, 'xiaohongshu_note should be registered');
  const value = await tool.call({ url: 'https://www.xiaohongshu.com/explore/n1?xsec_token=abc' }, new AbortController().signal) as Record<string, any>;
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.kind, 'note');
  assert.equal(value.note.title, '标题');
  assert.equal(value.note.stats.likes, '10');
  assert.match(String(value.text), /标题/);
  assert.match(String(value.text), /作者/);
});

test('xiaohongshu_note reads comments only when asked, within the documented bound', async () => {
  const { engine } = stubEngine();
  const { readers, seen } = stubNotes([{ id: 'c1', author: '甲', content: '说点什么', likes: '2', replies: '0' }]);
  const tools = createTools(xhsConfig(), identity, engine, undefined, readers);
  const tool = tools.find(item => item.name === 'xiaohongshu_note')!;
  const plain = await tool.call({ id: 'n1' }, new AbortController().signal) as Record<string, any>;
  assert.equal(plain.comments, undefined, 'comments are omitted unless they were asked for');
  assert.equal(seen[0]!.withComments, false, 'the read was told not to bring comments');
  const withComments = await tool.call({ id: 'n1', withComments: true, commentLimit: 99 }, new AbortController().signal) as Record<string, any>;
  assert.equal(withComments.comments.length, 1);
  assert.equal(withComments.commentsTruncated, true);
  assert.equal(seen.length, 2, 'the note and its comments were one read, not two');
  assert.equal(seen[1]!.withComments, true);
  assert.equal(seen[1]!.commentLimit, 50, 'the documented bound is applied');
});

test('xiaohongshu_note names the missing prerequisite instead of returning an empty note', async () => {
  const signal = new AbortController().signal;
  const { engine } = stubEngine();
  const { readers } = stubNotes();
  const tool = (config: ServerConfig) => createTools(config, identity, engine, undefined, readers).find(item => item.name === 'xiaohongshu_note')!;

  await assert.rejects(tool(xhsConfig()).call({}, signal), /share link or a note id/);

  const disabled = xhsConfig();
  disabled.search.backends.xiaohongshu!.enabled = false;
  await assert.rejects(tool(disabled).call({ id: 'n1' }, signal), /disabled/);

  const wrongMode = xhsConfig();
  wrongMode.search.backends.xiaohongshu!.mode = 'key';
  await assert.rejects(tool(wrongMode).call({ id: 'n1' }, signal), /browser mode/);

  const noEndpoint = xhsConfig();
  noEndpoint.search.browser.endpoint = '';
  noEndpoint.search.backends.xiaohongshu!.endpoint = '';
  await assert.rejects(tool(noEndpoint).call({ id: 'n1' }, signal), /browser endpoint/);
});

test('the tool list names every capability the server offers, with the gated one carried but off', () => {
  const tools = createTools(configWith(['exa']), identity, stubEngine().engine);
  assert.deepEqual(tools.map(item => item.name), ['web_search', 'reddit_thread', 'x_thread', 'xiaohongshu_note', 'web_extract', 'list_backends', 'search_manage']);
  const gated = tools.find(item => item.name === 'web_extract')!;
  assert.equal(gated.exposed?.(), false, 'the default configuration does not advertise it');
});

test('list_backends answers from the configuration present at call time', async () => {
  let current = configWith(['exa']);
  let revision = 0;
  const source = { get: () => current, revision: () => `r${revision}` };
  const tools = createTools(source, identity, stubEngine().engine);
  const list = tools.find(tool => tool.name === 'list_backends')!;
  const signal = new AbortController().signal;
  const first = await list.call({}, signal) as { enabled: string[] };
  assert.deepEqual(first.enabled, ['exa']);
  current = configWith(['reddit']);
  revision += 1;
  const second = await list.call({}, signal) as { enabled: string[] };
  assert.deepEqual(second.enabled, ['reddit'], 'a configuration replaced on disk is what the next call sees');
});
