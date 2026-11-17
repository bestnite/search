// X session search, exercised through an injected fetch: the search page carries the
// operation, the GraphQL read returns the timeline. No real network, no secrets in output.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchError } from '../src/transport.js';
import { findSearchOperation, literalToJson } from '../src/x/discovery.js';
import { parseInstructions, parseTweet } from '../src/x/parse.js';
import { resetXSessionState, searchXSession } from '../src/x/session.js';

const SEARCH_HTML = `<!doctype html><script data-tsr-stream-part>
self.$R[7]={id:"-8XxsqZkLb4vxNppbL2swQ",name:"SearchByRawQuery",variables:{rawQuery:"hello world",product:"Latest",querySource:"typed_query",count:20,cursor:null,withMediaGridTweet:!1,__relay_internal__pv__exampleflag:!0,__relay_internal__pv__otherflag:!1,nested:$R[9]}}
</script>`;

const tweet = (id: string, handle: string, text: string) => ({
  entryId: `tweet-${id}`,
  content: {
    entryType: 'TimelineTimelineItem',
    itemContent: {
      tweet_results: {
        result: {
          __typename: 'Tweet',
          rest_id: id,
          core: { user_results: { result: { core: { screen_name: handle } } } },
          legacy: { full_text: text, created_at: 'Sun Nov 16 10:00:00 +0000 2026', favorite_count: 12, retweet_count: 3, reply_count: 1 },
        },
      },
    },
  },
});

const graphqlBody = (ids: string[]) => ({
  data: {
    search_by_raw_query: {
      search_timeline: {
        timeline: {
          instructions: [{ type: 'TimelineAddEntries', entries: ids.map((id, index) => tweet(id, `user${index}`, `post number ${index}`)) }],
        },
      },
    },
  },
});

type Call = { url: string; headers: Record<string, string> };

function mockRouter(handler: (call: Call) => { status?: number; body?: unknown; text?: string }) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof URL ? input : input instanceof Request ? input.url : input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    const out = handler({ url, headers });
    return new Response(out.text ?? JSON.stringify(out.body ?? {}), { status: out.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const ctx = (fetcher: typeof fetch) => ({
  credentials: { authToken: 'secret-auth', ct0: 'secret-ct0' },
  signal: new AbortController().signal,
  timeoutMs: 5000,
  fetch: fetcher,
});

test('the search page literal is converted into usable variables', () => {
  const literal = '{rawQuery:"hello world",product:"Latest",count:20,withMediaGridTweet:!1,flag:!0,nested:$R[9]}';
  assert.deepEqual(literalToJson(literal), {
    rawQuery: 'hello world', product: 'Latest', count: 20, withMediaGridTweet: false, flag: true, nested: null,
  });
});

test('the operation is mined from the page that embeds it', () => {
  const operation = findSearchOperation(SEARCH_HTML);
  assert.ok(operation);
  assert.equal(operation!.queryId, '-8XxsqZkLb4vxNppbL2swQ');
  assert.equal(operation!.variables.withMediaGridTweet, false);
  assert.equal(operation!.variables.__relay_internal__pv__exampleflag, true);
  assert.equal(findSearchOperation('<html>no operation here</html>'), null);
});

test('a search reads the page, then calls the mined operation with its own switches', async () => {
  resetXSessionState();
  const { fetcher, calls } = mockRouter(({ url }) => (url.includes('/search?') ? { text: SEARCH_HTML } : { body: graphqlBody(['101', '102']) }));
  const sources = await searchXSession({ query: 'hello world', maxResults: 10 }, ctx(fetcher));
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /x\.com\/search\?/);
  assert.match(calls[0]!.headers.cookie ?? '', /auth_token=secret-auth/);
  assert.match(calls[1]!.url, /SearchByRawQuery\?variables=/);
  const variables = JSON.parse(decodeURIComponent(calls[1]!.url.split('variables=')[1] ?? '')) as Record<string, unknown>;
  assert.equal(variables.rawQuery, 'hello world');
  assert.equal(variables.count, 10);
  assert.equal(variables.withMediaGridTweet, false);
  assert.equal(variables.__relay_internal__pv__exampleflag, true, 'the site-provided switches must survive');
  assert.equal(calls[1]!.headers['x-csrf-token'], 'secret-ct0');
  assert.match(calls[1]!.headers.authorization ?? '', /^Bearer /);
  assert.equal(sources.length, 2);
  assert.equal(sources[0]!.url, 'https://x.com/user0/status/101');
  assert.equal(sources[0]!.publishedAt, '2026-11-16T10:00:00.000Z');
  assert.match(sources[0]!.summary!, /12 likes/);
});

test('the query id is cached between searches and reused', async () => {
  resetXSessionState();
  const { fetcher, calls } = mockRouter(({ url }) => (url.includes('/search?') ? { text: SEARCH_HTML } : { body: graphqlBody(['1']) }));
  await searchXSession({ query: 'a', maxResults: 5 }, ctx(fetcher));
  await searchXSession({ query: 'b', maxResults: 5 }, ctx(fetcher));
  assert.equal(calls.filter(call => call.url.includes('/search?')).length, 1, 'the page is read once per build');
  assert.equal(calls.filter(call => call.url.includes('SearchByRawQuery')).length, 2);
});

test('a rejected query id triggers one rediscovery and one retry', async () => {
  resetXSessionState();
  let pageReads = 0;
  const { fetcher, calls } = mockRouter(({ url }) => {
    if (url.includes('/search?')) { pageReads += 1; return { text: SEARCH_HTML }; }
    return calls.filter(call => call.url.includes('SearchByRawQuery')).length === 1 ? { status: 404 } : { body: graphqlBody(['7']) };
  });
  const sources = await searchXSession({ query: 'hello world', maxResults: 5 }, ctx(fetcher));
  assert.equal(pageReads, 2, 'rediscovery refetches the page');
  assert.equal(sources.length, 1);
});

test('a query id rejected twice ends as a maintainer failure, not a blank result', async () => {
  resetXSessionState();
  const { fetcher, calls } = mockRouter(({ url }) => (url.includes('/search?') ? { text: SEARCH_HTML } : { status: 404 }));
  await assert.rejects(searchXSession({ query: 'hello world', maxResults: 5 }, ctx(fetcher)), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.kind, 'protocol');
    assert.match(error.message, /maintainer/i);
    return true;
  });
  assert.equal(calls.filter(call => call.url.includes('SearchByRawQuery')).length, 2, 'exactly two reads, no retry storm');
});

test('rejected cookies and rate limits keep their own error kinds', async () => {
  for (const [status, kind] of [[401, 'authentication'], [403, 'authentication'], [429, 'rate-limit']] as const) {
    resetXSessionState();
    const { fetcher } = mockRouter(() => ({ status }));
    await assert.rejects(searchXSession({ query: 'q', maxResults: 5 }, ctx(fetcher)), (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.kind, kind);
      assert.doesNotMatch(error.message, /secret-auth|secret-ct0/);
      return true;
    });
  }
});

test('a signed-out search page is reported as an expired session', async () => {
  resetXSessionState();
  const { fetcher } = mockRouter(() => ({ text: '<html><script src="https://abs.twimg.com/x-web/x-web/entry-client-logged-out-abc.js"></script></html>' }));
  await assert.rejects(searchXSession({ query: 'q', maxResults: 5 }, ctx(fetcher)), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.kind, 'authentication');
    assert.match(error.message, /signed-out page/);
    return true;
  });
});

test('a page without the operation reports a migration, not a session problem', async () => {
  resetXSessionState();
  const { fetcher } = mockRouter(() => ({ text: '<html><script src="https://abs.twimg.com/x-web/x-web/entry-client-DpQAcGwb.js"></script></html>' }));
  await assert.rejects(searchXSession({ query: 'q', maxResults: 5 }, ctx(fetcher)), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.kind, 'protocol');
    assert.match(error.message, /SearchByRawQuery/);
    return true;
  });
});

test('graphql validation errors are surfaced instead of returning nothing', async () => {
  resetXSessionState();
  const { fetcher } = mockRouter(({ url }) => (url.includes('/search?')
    ? { text: SEARCH_HTML }
    : { body: { errors: [{ message: 'must be defined', path: ['variable', 'withMediaGridTweet'] }] } }));
  await assert.rejects(searchXSession({ query: 'hello world', maxResults: 5 }, ctx(fetcher)), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.kind, 'protocol');
    assert.match(error.message, /must be defined/);
    return true;
  });
});

test('the 2026 tweet shape reads body, date and counts from details and counts', () => {
  const parsed = parseTweet({
    rest_id: '99',
    core: { user_results: { result: { core: { screen_name: 'newshape' } } } },
    details: { full_text: 'body from details', created_at_ms: 1794907963000 },
    counts: { favorite_count: 5, retweet_count: 2, reply_count: 1 },
    legacy: { conversation_id_str: '1' },
  });
  assert.equal(parsed!.handle, 'newshape');
  assert.equal(parsed!.text, 'body from details');
  assert.equal(parsed!.createdAt, new Date(1794907963000).toISOString());
  assert.equal(parsed!.likes, 5);
  assert.equal(parsed!.reposts, 2);
});

test('parsing walks modules and visibility wrappers and skips empty bodies', () => {
  const wrapper = {
    __typename: 'TweetWithVisibilityResults',
    tweet: {
      rest_id: '55',
      note_tweet: { note_tweet_results: { result: { text: 'long form body' } } },
      core: { user_results: { result: { legacy: { screen_name: 'legacyhandle' } } } },
      legacy: { favorite_count: 1 },
    },
  };
  const parsed = parseTweet(wrapper);
  assert.equal(parsed!.id, '55');
  assert.equal(parsed!.handle, 'legacyhandle');
  assert.equal(parsed!.text, 'long form body');
  assert.equal(parseTweet({ rest_id: '56', legacy: { full_text: '' } })!.text, '');

  const body = {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [{
              type: 'TimelineTimelineModule',
              entries: [
                { content: { items: [{ item: { itemContent: { tweet_results: { result: wrapper } } } }] } },
                { content: { itemContent: { tweet_results: { result: { __typename: 'Tweet', rest_id: '57', legacy: { full_text: 'second' } } } } } },
              ],
            }],
          },
        },
      },
    },
  };
  const tweets = parseInstructions(body, 10);
  assert.deepEqual(tweets.map(item => item.id), ['55', '57']);
  assert.deepEqual(parseInstructions(body, 1).map(item => item.id), ['55']);
});
