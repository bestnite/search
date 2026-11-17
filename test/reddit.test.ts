// Reddit read paths, exercised entirely through an injected fetch: no real network.
//
// Every assertion about an endpoint, a header or an operation hash reads the constant from the
// implementation instead of restating it, so a wrong constant fails on behaviour rather than on a
// duplicated literal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDDIT_USER_AGENT } from '../src/reddit/auth.js';
import { APP_USER_AGENT } from '../src/ua.js';
import { SearchError } from '../src/transport.js';
import {
  ANDROID_CLIENT_ID,
  ANONYMOUS_TOKEN_BODY,
  ANONYMOUS_TOKEN_URL,
  OAUTH_TOKEN_URL,
  resetRedditTokenCache,
} from '../src/reddit/auth.js';
import { GQL_URL, OPERATIONS } from '../src/reddit/gql.js';
import { getProcessDevice } from '../src/reddit/device.js';
import { fetchRedditThread, searchReddit, type RedditContext } from '../src/reddit/index.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function mockFetch(respond: (call: Call) => Response | Promise<Response>): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit | undefined) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function context(
  mode: 'oauth' | 'anonymous',
  credentials: Record<string, string>,
  fetchImpl: typeof fetch,
): RedditContext {
  return { mode, credentials, signal: new AbortController().signal, timeoutMs: 5000, fetch: fetchImpl };
}

function tokenResponse(token: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function searchPayload(nodes: Array<Record<string, unknown>>): Response {
  return Response.json({
    data: { search: { general: { posts: { edges: nodes.map((node) => ({ node })) } } } },
  });
}

function commentPayload(trees: Array<Record<string, unknown>>, commentCount = trees.length): Response {
  return Response.json({ data: { postInfoById: { commentCount, commentForest: { trees } } } });
}

function postListing(overrides: Record<string, unknown> = {}): Response {
  const data = {
    id: 'abc123',
    title: 'A post title',
    permalink: '/r/test/comments/abc123/a_post_title/',
    author: 'bob',
    score: 9,
    created_utc: 1762000000,
    selftext: 'post body',
    num_comments: 3,
    url: 'https://example.org/link',
    ...overrides,
  };
  return Response.json({ kind: 'Listing', data: { after: null, children: [{ kind: 't3', data }] } });
}

function gqlNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't3_abc123',
    title: 'A post title',
    permalink: '/r/test/comments/abc123/a_post_title/',
    authorInfo: { name: 'bob' },
    score: 9,
    commentCount: 3,
    createdAt: '2026-10-30T06:10:28.665000+0000',
    content: { markdown: 'post body' },
    ...overrides,
  };
}

async function expectSearchError(promise: Promise<unknown>, kind: string): Promise<SearchError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SearchError, `expected SearchError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    return error;
  }
  assert.fail('expected the call to fail');
}

// ---------------------------------------------------------------------------
// anonymous path
// ---------------------------------------------------------------------------

test('anonymous token request uses the Android client id, the device headers and the loid body', async () => {
  resetRedditTokenCache();
  const device = getProcessDevice();
  const { calls, fetch } = mockFetch((call) =>
    call.url === ANONYMOUS_TOKEN_URL ? tokenResponse('ANON_TOKEN', { 'x-reddit-loid': 'LOID_1' }) : searchPayload([gqlNode()]),
  );

  const sources = await searchReddit({ query: 'hello', maxResults: 5 }, context('anonymous', {}, fetch));

  const [tokenCall, gqlCall] = calls;
  assert.equal(calls.length, 2);
  assert.equal(tokenCall!.url, ANONYMOUS_TOKEN_URL);
  assert.equal(tokenCall!.method, 'POST');
  assert.equal(tokenCall!.headers.Authorization, `Basic ${Buffer.from(`${ANDROID_CLIENT_ID}:`).toString('base64')}`);
  for (const [name, value] of Object.entries(device.headers)) {
    assert.equal(tokenCall!.headers[name], value, `token request must carry the device header ${name}`);
  }
  assert.deepEqual(JSON.parse(tokenCall!.body), JSON.parse(ANONYMOUS_TOKEN_BODY));

  assert.equal(gqlCall!.url, GQL_URL);
  assert.equal(gqlCall!.method, 'POST');
  assert.equal(gqlCall!.headers.Authorization, 'Bearer ANON_TOKEN');
  assert.equal(gqlCall!.headers['x-reddit-loid'], 'LOID_1');
  assert.equal(gqlCall!.headers['client-vendor-id'], device.uuid);
  const body = JSON.parse(gqlCall!.body) as {
    operationName: string;
    variables: Record<string, unknown>;
    extensions: { persistedQuery: { version: number; sha256Hash: string } };
  };
  assert.equal(body.operationName, OPERATIONS.searchPosts.name);
  assert.equal(body.extensions.persistedQuery.sha256Hash, OPERATIONS.searchPosts.hash);
  assert.equal(body.extensions.persistedQuery.version, 1);
  assert.equal(body.variables.pageSize, 5);
  assert.equal(body.variables.sort, 'RELEVANCE');
  assert.equal(body.variables.query, 'hello');

  assert.ok(!calls.some((call) => call.url === OAUTH_TOKEN_URL), 'anonymous mode never touches the OAuth token endpoint');

  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.url, 'https://www.reddit.com/r/test/comments/abc123/a_post_title/');
  assert.equal(sources[0]!.title, 'A post title');
  assert.equal(sources[0]!.snippet, 'post body');
  assert.equal(sources[0]!.publishedAt, '2026-10-30T06:10:28.000Z');
});

test('anonymous thread reads comments from gql and post metadata from /by_id', async () => {
  resetRedditTokenCache();
  const { calls, fetch } = mockFetch((call) => {
    if (call.url === ANONYMOUS_TOKEN_URL) return tokenResponse('ANON_TOKEN');
    if (call.url === GQL_URL) {
      return commentPayload([
        { depth: 0, parentId: null, node: { id: 't1_a', authorInfo: { name: 'alice' }, content: { markdown: 'top' }, score: 4, createdAt: '2026-10-30T06:10:28+0000' } },
        { depth: 1, parentId: 't1_a', node: { id: 't1_b', authorInfo: { name: 'bea' }, content: { markdown: 'reply' }, score: 2 } },
        { depth: 0, parentId: null, node: { id: 't1_c', authorInfo: { name: 'carl' }, content: { markdown: 'second' }, score: 1 } },
      ]);
    }
    return postListing();
  });

  const thread = await fetchRedditThread(
    { id: 'abc123', sort: 'top', limit: 10, depth: 3, maxChars: 10_000 },
    context('anonymous', {}, fetch),
  );

  assert.equal(calls.length, 3);
  const gqlBody = JSON.parse(calls[1]!.body) as { operationName: string; variables: Record<string, unknown> };
  assert.equal(gqlBody.operationName, OPERATIONS.comments.name);
  assert.equal(gqlBody.variables.id, 't3_abc123');
  assert.equal(gqlBody.variables.sortType, 'TOP');
  assert.equal(gqlBody.variables.count, 10);
  assert.equal(gqlBody.variables.maxDepth, 3);
  assert.equal(calls[2]!.url, 'https://oauth.reddit.com/by_id/t3_abc123?raw_json=1');
  assert.equal(calls[2]!.headers.Authorization, 'Bearer ANON_TOKEN');

  assert.deepEqual(thread.post, {
    id: 'abc123',
    title: 'A post title',
    url: 'https://www.reddit.com/r/test/comments/abc123/a_post_title/',
    author: 'bob',
    score: 9,
    createdUtc: 1762000000,
    selfText: 'post body',
  });
  assert.equal(thread.comments.length, 2);
  assert.equal(thread.comments[0]!.author, 'alice');
  assert.equal(thread.comments[0]!.depth, 0);
  assert.equal(thread.comments[0]!.createdUtc, Math.floor(Date.parse('2026-10-30T06:10:28Z') / 1000));
  assert.equal(thread.comments[0]!.replies.length, 1);
  assert.equal(thread.comments[0]!.replies[0]!.depth, 1);
  assert.equal(thread.comments[1]!.body, 'second');
  assert.equal(thread.truncated, false);
});

test('a token cached in the process is reused and refreshed only on 401', async () => {
  resetRedditTokenCache();
  let tokenCalls = 0;
  const { calls, fetch } = mockFetch((call) => {
    if (call.url === ANONYMOUS_TOKEN_URL) {
      tokenCalls++;
      return tokenResponse(`TOKEN_${tokenCalls}`);
    }
    return searchPayload([gqlNode()]);
  });
  const ctx = context('anonymous', {}, fetch);

  await searchReddit({ query: 'first', maxResults: 3 }, ctx);
  await searchReddit({ query: 'second', maxResults: 3 }, ctx);
  assert.equal(tokenCalls, 1);
  assert.equal(calls.length, 3);

  // The stale token is rejected once, the client refreshes and retries exactly once.
  resetRedditTokenCache();
  let gqlCalls = 0;
  const retry = mockFetch((call) => {
    if (call.url === ANONYMOUS_TOKEN_URL) {
      tokenCalls++;
      return tokenResponse(`TOKEN_${tokenCalls}`);
    }
    gqlCalls++;
    return gqlCalls === 1 ? new Response('denied', { status: 401 }) : searchPayload([gqlNode()]);
  });
  const sources = await searchReddit({ query: 'third', maxResults: 3 }, context('anonymous', {}, retry.fetch));
  assert.equal(sources.length, 1);
  assert.equal(gqlCalls, 2);
  assert.equal(retry.calls[2]!.url, ANONYMOUS_TOKEN_URL, 'the 401 path refetches the token');
  assert.equal(retry.calls[3]!.headers.Authorization, `Bearer TOKEN_${tokenCalls}`);
});

test('anonymous 429 rotates the token once, retries once, then reports rate-limit', async () => {
  resetRedditTokenCache();
  let gqlCalls = 0;
  let tokenCalls = 0;
  const { calls, fetch } = mockFetch((call) => {
    if (call.url === ANONYMOUS_TOKEN_URL) {
      tokenCalls++;
      return tokenResponse(`TOKEN_${tokenCalls}`);
    }
    gqlCalls++;
    return new Response('slow down', { status: 429 });
  });

  const error = await expectSearchError(
    searchReddit({ query: 'hello', maxResults: 3 }, context('anonymous', {}, fetch)),
    'rate-limit',
  );

  assert.equal(gqlCalls, 2);
  assert.equal(tokenCalls, 2, 'a 429 rotates the token before the single retry');
  assert.equal(calls.length, 4);
  assert.ok(!/slow down/.test(error.message));
});

test('gql error payloads and unrecognised shapes are protocol failures', async () => {
  resetRedditTokenCache();
  const expired = mockFetch((call) =>
    call.url === ANONYMOUS_TOKEN_URL
      ? tokenResponse('ANON_TOKEN')
      : Response.json({ errors: [{ message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }] }),
  );
  const error = await expectSearchError(
    searchReddit({ query: 'hello', maxResults: 3 }, context('anonymous', {}, expired.fetch)),
    'protocol',
  );
  assert.match(error.message, /PERSISTED_QUERY_NOT_FOUND/);

  resetRedditTokenCache();
  const shapeless = mockFetch((call) =>
    call.url === ANONYMOUS_TOKEN_URL ? tokenResponse('ANON_TOKEN') : Response.json({ data: { search: { general: {} } } }),
  );
  await expectSearchError(
    searchReddit({ query: 'hello', maxResults: 3 }, context('anonymous', {}, shapeless.fetch)),
    'protocol',
  );
});

test('comments respect depth, top-level limit and the character budget', async () => {
  const trees = [
    { depth: 0, parentId: null, node: { id: 't1_a', authorInfo: { name: 'a' }, content: { markdown: 'x'.repeat(40) } } },
    { depth: 1, parentId: 't1_a', node: { id: 't1_b', authorInfo: { name: 'b' }, content: { markdown: 'y'.repeat(40) } } },
    { depth: 0, parentId: null, node: { id: 't1_c', authorInfo: { name: 'c' }, content: { markdown: 'z'.repeat(40) } } },
    { depth: 0, parentId: null, node: { id: 't1_d', authorInfo: { name: 'd' }, content: { markdown: 'w'.repeat(40) } } },
  ];
  const read = async (input: { id?: string; limit: number; depth: number; maxChars: number }) => {
    resetRedditTokenCache();
    const { fetch } = mockFetch((call) => {
      if (call.url === ANONYMOUS_TOKEN_URL) return tokenResponse('ANON_TOKEN');
      if (call.url === GQL_URL) return commentPayload(trees);
      return postListing();
    });
    return fetchRedditThread({ id: 't3_abc123', ...input }, context('anonymous', {}, fetch));
  };

  const shallow = await read({ limit: 10, depth: 1, maxChars: 10_000 });
  assert.equal(shallow.comments.length, 3);
  assert.deepEqual(shallow.comments.map((comment) => comment.replies.length), [0, 0, 0]);

  const limited = await read({ limit: 2, depth: 2, maxChars: 10_000 });
  assert.equal(limited.comments.length, 2);
  assert.equal(limited.comments[0]!.replies.length, 1);
  assert.equal(limited.truncated, false);

  const trimmed = await read({ limit: 2, depth: 1, maxChars: 50 });
  const bodies = trimmed.comments.flatMap((comment) => [comment.body, ...comment.replies.map((r) => r.body)]);
  assert.equal(trimmed.truncated, true);
  assert.equal(trimmed.comments[0]!.body, 'x'.repeat(40));
  assert.equal(trimmed.comments[1]!.body.length, 10);
  assert.ok(bodies.join('').length <= 50);

  // A full permalink URL is accepted in place of a bare id.
  const fromUrl = await read({ id: 'https://www.reddit.com/r/test/comments/abc123/t3_ignored/', limit: 1, depth: 1, maxChars: 10_000 });
  assert.equal(fromUrl.comments.length, 1);

  // A t3_ fullname is accepted too.
  const fromFullname = await read({ id: 't3_abc123', limit: 1, depth: 1, maxChars: 10_000 });
  assert.equal(fromFullname.post.id, 'abc123');
});

// ---------------------------------------------------------------------------
// oauth path
// ---------------------------------------------------------------------------

test('oauth client_credentials token request and search use Basic auth on the REST endpoints', async () => {
  resetRedditTokenCache();
  const secret = 'CLIENT_SECRET_VALUE';
  const { calls, fetch } = mockFetch((call) => {
    if (call.url === OAUTH_TOKEN_URL) return tokenResponse('OAUTH_TOKEN');
    return Response.json({
      kind: 'Listing',
      data: {
        children: [
          {
            kind: 't3',
            data: {
              id: 'xyz789',
              title: 'Result title',
              permalink: 'https://www.reddit.com/r/test/comments/xyz789/result_title/',
              author: 'dana',
              score: 42,
              created_utc: 1762000000,
              selftext: '',
              num_comments: 7,
            },
          },
        ],
      },
    });
  });

  const sources = await searchReddit(
    { query: 'hello world', maxResults: 5, sort: 'top', time: 'week' },
    context('oauth', { clientId: 'MY_CLIENT_ID', clientSecret: secret }, fetch),
  );

  const tokenCall = calls[0]!;
  assert.equal(tokenCall.url, OAUTH_TOKEN_URL);
  assert.equal(tokenCall.method, 'POST');
  assert.equal(
    tokenCall.headers.Authorization,
    `Basic ${Buffer.from(`MY_CLIENT_ID:${secret}`).toString('base64')}`,
  );
  assert.equal(tokenCall.body, 'grant_type=client_credentials');
  assert.equal(tokenCall.headers['client-vendor-id'], undefined, 'oauth mode must not send Android device headers');

  const searchUrl = new URL(calls[1]!.url);
  assert.equal(calls[1]!.method, 'GET');
  assert.equal(searchUrl.origin + searchUrl.pathname, 'https://oauth.reddit.com/search');
  assert.equal(searchUrl.searchParams.get('q'), 'hello world');
  assert.equal(searchUrl.searchParams.get('sort'), 'top');
  assert.equal(searchUrl.searchParams.get('t'), 'week');
  assert.equal(searchUrl.searchParams.get('limit'), '5');
  assert.equal(searchUrl.searchParams.get('raw_json'), '1');
  assert.equal(calls[1]!.headers.Authorization, 'Bearer OAUTH_TOKEN');

  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.url, 'https://www.reddit.com/r/test/comments/xyz789/result_title/');
  assert.equal(sources[0]!.title, 'Result title');
  assert.match(sources[0]!.snippet!, /by u\/dana/);
  assert.match(sources[0]!.snippet!, /42 points/);
});

test('oauth password grant sends username and password and never touches gql', async () => {
  resetRedditTokenCache();
  const { calls, fetch } = mockFetch((call) => {
    if (call.url === OAUTH_TOKEN_URL) return tokenResponse('OAUTH_TOKEN');
    return Response.json({ kind: 'Listing', data: { children: [] } });
  });

  await searchReddit(
    { query: 'hello', maxResults: 2, subreddit: 'r/test' },
    context('oauth', { clientId: 'ID', clientSecret: 'SECRET', username: 'alice', password: 'p@ss word' }, fetch),
  );

  const body = calls[0]!.body;
  assert.equal(
    body,
    `grant_type=password&username=${encodeURIComponent('alice')}&password=${encodeURIComponent('p@ss word')}`,
  );
  assert.equal(
    calls[0]!.headers.Authorization,
    `Basic ${Buffer.from('ID:SECRET').toString('base64')}`,
  );
  assert.ok(!calls.some((call) => call.url === GQL_URL), 'oauth mode never falls back to gql');
  assert.ok(!calls.some((call) => call.url === ANONYMOUS_TOKEN_URL), 'oauth mode never uses the anonymous token');
  const searchUrl = new URL(calls[1]!.url);
  assert.equal(searchUrl.searchParams.get('q'), 'hello subreddit:test');
  assert.equal(searchUrl.pathname, '/search');
});

test('oauth thread parses the [post, comments] payload with nesting', async () => {
  resetRedditTokenCache();
  const { calls, fetch } = mockFetch((call) => {
    if (call.url === OAUTH_TOKEN_URL) return tokenResponse('OAUTH_TOKEN');
    return Response.json([
      { kind: 'Listing', data: { children: [{ kind: 't3', data: { id: 'abc123', title: 'T', permalink: '/r/test/comments/abc123/t/', author: 'eve', score: 3, created_utc: 1762000000, selftext: 'body', num_comments: 2 } }] } },
      {
        kind: 'Listing',
        data: {
          children: [
            {
              kind: 't1',
              data: {
                author: 'frank',
                score: 5,
                body: 'top comment',
                created_utc: 1762000100,
                replies: {
                  kind: 'Listing',
                  data: { children: [{ kind: 't1', data: { author: 'gina', score: 1, body: 'nested reply', replies: '' } }] },
                },
              },
            },
            { kind: 'more', data: { count: 4, children: [] } },
          ],
        },
      },
    ]);
  });

  const thread = await fetchRedditThread(
    { id: 'https://www.reddit.com/r/test/comments/abc123/t/', sort: 'new', limit: 5, depth: 2, maxChars: 10_000 },
    context('oauth', { clientId: 'ID', clientSecret: 'SECRET' }, fetch),
  );

  const commentsUrl = new URL(calls[1]!.url);
  assert.equal(commentsUrl.origin + commentsUrl.pathname, 'https://oauth.reddit.com/comments/abc123');
  assert.equal(commentsUrl.searchParams.get('sort'), 'new');
  assert.equal(commentsUrl.searchParams.get('limit'), '5');
  assert.equal(commentsUrl.searchParams.get('depth'), '2');
  assert.equal(commentsUrl.searchParams.get('raw_json'), '1');

  assert.equal(thread.post.title, 'T');
  assert.equal(thread.post.author, 'eve');
  assert.equal(thread.post.url, 'https://www.reddit.com/r/test/comments/abc123/t/');
  assert.equal(thread.comments.length, 1);
  assert.equal(thread.comments[0]!.author, 'frank');
  assert.equal(thread.comments[0]!.replies[0]!.author, 'gina');
  assert.equal(thread.comments[0]!.replies[0]!.depth, 1);

  resetRedditTokenCache();
  const shallowFetch = mockFetch((call) => {
    if (call.url === OAUTH_TOKEN_URL) return tokenResponse('OAUTH_TOKEN');
    return Response.json([
      { kind: 'Listing', data: { children: [{ kind: 't3', data: { id: 'abc123', title: 'T', permalink: '/r/test/comments/abc123/t/', author: 'eve', score: 3 } }] } },
      {
        kind: 'Listing',
        data: {
          children: [
            {
              kind: 't1',
              data: {
                author: 'frank',
                score: 5,
                body: 'top',
                replies: { kind: 'Listing', data: { children: [{ kind: 't1', data: { author: 'gina', body: 'nested' } }] } },
              },
            },
          ],
        },
      },
    ]);
  });
  const shallow = await fetchRedditThread(
    { id: 'abc123', limit: 5, depth: 1, maxChars: 10_000 },
    context('oauth', { clientId: 'ID', clientSecret: 'SECRET' }, shallowFetch.fetch),
  );
  assert.equal(shallow.comments[0]!.replies.length, 0, 'depth 1 keeps top-level comments only');
});

// ---------------------------------------------------------------------------
// failures
// ---------------------------------------------------------------------------

test('missing credentials fail as configuration without sending a request', async () => {
  resetRedditTokenCache();
  const incomplete: Array<Record<string, string>> = [
    { clientId: 'ONLY_ID' },
    { clientSecret: 'ONLY_SECRET' },
    {},
    { clientId: 'ID', clientSecret: 'SECRET', username: 'alice' },
  ];
  for (const credentials of incomplete) {
    const { calls, fetch } = mockFetch(() => tokenResponse('NEVER'));
    const error = await expectSearchError(
      searchReddit({ query: 'hello', maxResults: 3 }, context('oauth', credentials, fetch)),
      'configuration',
    );
    assert.equal(calls.length, 0);
    assert.ok(!JSON.stringify(error.message).includes('ONLY_SECRET'));
  }
  const anon = mockFetch(() => tokenResponse('NEVER'));
  await expectSearchError(
    fetchRedditThread({ id: '', limit: 5, depth: 2, maxChars: 100 }, context('anonymous', {}, anon.fetch)),
    'configuration',
  );
  assert.equal(anon.calls.length, 0);
});

test('invalid input is rejected as configuration before any request', async () => {
  resetRedditTokenCache();
  const cases: Array<() => Promise<unknown>> = [
    () => searchReddit({ query: '   ', maxResults: 3 }, context('anonymous', {}, mockFetch(() => tokenResponse('X')).fetch)),
    () => searchReddit({ query: 'x', maxResults: 0 }, context('anonymous', {}, mockFetch(() => tokenResponse('X')).fetch)),
    () => searchReddit({ query: 'x', maxResults: 3, sort: 'bogus' }, context('anonymous', {}, mockFetch(() => tokenResponse('X')).fetch)),
    () => searchReddit({ query: 'x', maxResults: 3, time: 'decade' }, context('anonymous', {}, mockFetch(() => tokenResponse('X')).fetch)),
    () => fetchRedditThread({ id: 'not an id!', limit: 5, depth: 2, maxChars: 100 }, context('anonymous', {}, mockFetch(() => tokenResponse('X')).fetch)),
    () => fetchRedditThread({ id: 'abc123', limit: 5, depth: 2, maxChars: 0 }, context('anonymous', {}, mockFetch(() => tokenResponse('X')).fetch)),
  ];
  for (const run of cases) await expectSearchError(run(), 'configuration');
});

test('network failures and aborts surface as network and timeout', async () => {
  resetRedditTokenCache();
  const network = mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  await expectSearchError(
    searchReddit({ query: 'hello', maxResults: 3 }, context('anonymous', {}, network.fetch)),
    'network',
  );

  resetRedditTokenCache();
  const aborted = mockFetch(() => {
    throw new DOMException('This operation was aborted', 'AbortError');
  });
  await expectSearchError(
    searchReddit({ query: 'hello', maxResults: 3 }, context('anonymous', {}, aborted.fetch)),
    'timeout',
  );
});

test('an authentication failure explains that the anonymous path may need oauth', async () => {
  resetRedditTokenCache();
  const blocked = mockFetch((call) =>
    call.url === ANONYMOUS_TOKEN_URL ? tokenResponse('ANON_TOKEN') : new Response('<html>blocked</html>', { status: 403 }),
  );
  const error = await expectSearchError(
    searchReddit({ query: 'hello', maxResults: 3 }, context('anonymous', {}, blocked.fetch)),
    'authentication',
  );
  assert.match(error.message, /oauth/);
  assert.ok(!error.message.includes('blocked</html>'));
});

test('a 5xx from gql is reported once and never retried', async () => {
  resetRedditTokenCache();
  const { calls, fetch } = mockFetch((call) =>
    call.url === ANONYMOUS_TOKEN_URL ? tokenResponse('ANON_TOKEN') : new Response('oops', { status: 500 }),
  );
  await expectSearchError(
    searchReddit({ query: 'hello', maxResults: 3 }, context('anonymous', {}, fetch)),
    'network',
  );
  assert.equal(calls.length, 2, 'only the initial attempt is sent; a 5xx is not retried');
});

test('no failure message carries a token, a client secret, a password or an upstream body', async () => {
  resetRedditTokenCache();
  const secret = 'SUPER_SECRET_VALUE';
  const password = 'USER_PASSWORD_VALUE';
  const upstream = 'UPSTREAM_BODY_WITH_TOKEN_VALUE';

  const tokenFailure = mockFetch(
    () => new Response(upstream, { status: 500 }),
  );
  const first = await expectSearchError(
    searchReddit(
      { query: 'hello', maxResults: 3 },
      context('oauth', { clientId: 'ID', clientSecret: secret, username: 'alice', password }, tokenFailure.fetch),
    ),
    'network',
  );

  resetRedditTokenCache();
  const dataFailure = mockFetch((call) =>
    call.url === OAUTH_TOKEN_URL ? tokenResponse('TOKEN_VALUE_IN_BODY') : new Response(upstream, { status: 502 }),
  );
  const second = await expectSearchError(
    searchReddit({ query: 'hello', maxResults: 3 }, context('oauth', { clientId: 'ID', clientSecret: secret }, dataFailure.fetch)),
    'network',
  );

  resetRedditTokenCache();
  const gqlFailure = mockFetch((call) =>
    call.url === ANONYMOUS_TOKEN_URL ? tokenResponse('ANON_TOKEN_VALUE') : Response.json({ errors: [{ message: upstream }] }),
  );
  const third = await expectSearchError(
    searchReddit({ query: 'hello', maxResults: 3 }, context('anonymous', {}, gqlFailure.fetch)),
    'protocol',
  );

  for (const error of [first, second, third]) {
    for (const leak of [secret, password, upstream, 'TOKEN_VALUE_IN_BODY', 'ANON_TOKEN_VALUE']) {
      assert.ok(!error.message.includes(leak), `error leaked ${leak}: ${error.message}`);
    }
  }
});

test('the OAuth client identifies itself with version and project, the anonymous path does not', async () => {
  assert.equal(REDDIT_USER_AGENT, APP_USER_AGENT);
  assert.match(APP_USER_AGENT, /^dsh-search\/\S+ \(\+https:\/\/\S+\)$/);
  const calls: Array<Record<string, string>> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push((init?.headers ?? {}) as Record<string, string>);
    const url = String(input);
    if (url.includes('access-token/loid')) return new Response(JSON.stringify({ access_token: 'anon-token', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ data: { search: { general: { posts: { edges: [] } } } } }), { status: 200 });
  }) as unknown as typeof fetch;
  await searchReddit({ query: 'q', maxResults: 5 }, { mode: 'anonymous', credentials: {}, signal: new AbortController().signal, timeoutMs: 3000, fetch: fetcher });
  assert.ok(calls.length > 0);
  for (const headers of calls) assert.notEqual(headers['User-Agent'], REDDIT_USER_AGENT, 'anonymous requests must keep the Android client identity');
});
