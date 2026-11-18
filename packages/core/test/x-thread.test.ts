// Reading one X conversation: the status page carries the TweetDetail operation, the GraphQL
// read returns the thread. Everything below runs against an injected fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchError } from '../src/transport.js';
import { findKeyedOperation, findOperation } from '../src/x/discovery.js';
import { fetchXThread, normaliseId, resetXThreadState } from '../src/x/thread.js';
import { parseThread } from '../src/x/parse.js';

const variables = {
  __relay_internal__pv__exampleflag: true, cursor: null, focalTweetId: '999', rankingMode: null, referrer: null, withFocalTweet: true,
};
const STATUS_HTML = `<script>self.$R[36]={kind:0,requestId:3,key:"tCJWJBzmBXpHvd0THltseA${JSON.stringify(variables).replace(/"/g, '\\"')}",name:"TweetDetail"}</script>`;

const tweet = (id: string, handle: string, text: string, counts = { favorite_count: 1, retweet_count: 0, reply_count: 0 }) => ({
  rest_id: id,
  core: { user_results: { result: { core: { screen_name: handle } } } },
  details: { full_text: text, created_at_ms: 1794907963000 },
  counts,
});

const conversation = (ids: string[]) => ({
  data: {
    threaded_conversation_with_injections_v2: {
      instructions: [{
        __typename: 'TimelineAddEntries',
        entries: ids.map(id => ({
          entry_id: `tweet-${id}`,
          content: { __typename: 'TimelineTimelineItem', content: { tweet_results: { result: tweet(id, `user_${id}`, `reply body ${id}`) } } },
        })),
      }],
    },
  },
});

type Call = { url: string };
function mockRouter(handler: (call: Call) => { status?: number; body?: unknown; text?: string }) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    const out = handler({ url });
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

test('post ids are accepted as ids, permalinks and status urls', () => {
  assert.equal(normaliseId('2122623277998960727'), '2122623277998960727');
  assert.equal(normaliseId('https://x.com/someone/status/2122623277998960727'), '2122623277998960727');
  assert.equal(normaliseId('https://twitter.com/i/web/status/2122623277998960727?s=20'), '2122623277998960727');
  assert.equal(normaliseId('not a post'), undefined);
});

test('the keyed serialization of an operation is mined with its variables', () => {
  const operation = findKeyedOperation(STATUS_HTML, 'TweetDetail');
  assert.ok(operation);
  assert.equal(operation!.queryId, 'tCJWJBzmBXpHvd0THltseA');
  assert.equal(operation!.variables.focalTweetId, '999');
  assert.equal(operation!.variables.__relay_internal__pv__exampleflag, true);
  assert.equal(findOperation(STATUS_HTML, 'TweetDetail')!.queryId, 'tCJWJBzmBXpHvd0THltseA');
  assert.equal(findOperation(STATUS_HTML, 'SearchByRawQuery'), null);
});

test('a conversation is read as a post plus flattened replies', async () => {
  resetXThreadState();
  const { fetcher, calls } = mockRouter(({ url }) => (url.includes('/status/') ? { text: STATUS_HTML } : { body: conversation(['999', '1001', '1002']) }));
  const thread = await fetchXThread({ id: 'https://x.com/a/status/999', limit: 10, depth: 3, maxChars: 5000 }, ctx(fetcher));
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /\/status\/999/);
  assert.match(calls[1]!.url, /TweetDetail\?variables=/);
  const sent = JSON.parse(decodeURIComponent(calls[1]!.url.split('variables=')[1] ?? '')) as Record<string, unknown>;
  assert.equal(sent.focalTweetId, '999', 'the focal post wins over whatever the page was showing');
  assert.equal(thread.post.id, '999');
  assert.deepEqual(thread.replies.map(reply => reply.id), ['1001', '1002']);
  assert.equal(thread.replies[0]!.url, 'https://x.com/user_1001/status/1001');
});

test('replies respect the count, depth and character budgets', async () => {
  resetXThreadState();
  const long = (id: string) => ({
    entry_id: `tweet-${id}`,
    content: { content: { tweet_results: { result: tweet(id, 'h', 'x'.repeat(400)) } } },
  });
  const body = { data: { threaded_conversation_with_injections_v2: { instructions: [{ entries: [long('999'), long('1'), long('2'), long('3')] }] } } };
  const { fetcher } = mockRouter(({ url }) => (url.includes('/status/') ? { text: STATUS_HTML } : { body }));
  const limited = await fetchXThread({ id: '999', limit: 2, depth: 3, maxChars: 10000 }, ctx(fetcher));
  assert.deepEqual(limited.replies.map(reply => reply.id), ['1', '2']);
  assert.equal(limited.truncated, true);
  const budgeted = await fetchXThread({ id: '999', limit: 10, depth: 3, maxChars: 500 }, ctx(fetcher));
  assert.equal(budgeted.replies[0]!.text.length, 400);
  assert.equal(budgeted.replies[1]!.text.length, 100, 'the second reply is cut to the remaining budget');
  assert.equal(budgeted.truncated, true);
});

test('module entries nest replies one level deeper and are dropped past the depth limit', () => {
  const moduleEntry = {
    entry_id: 'conversationthread-1',
    content: {
      __typename: 'TimelineTimelineModule',
      items: [
        { item: { itemContent: { tweet_results: { result: tweet('2001', 'a', 'nested reply') } } } },
        { item: { itemContent: { tweet_results: { result: tweet('2002', 'b', 'second nested') } } } },
      ],
    },
  };
  const body = { data: { threaded_conversation_with_injections_v2: { instructions: [{ entries: [
    { entry_id: 'tweet-999', content: { content: { tweet_results: { result: tweet('999', 'root', 'the post') } } } },
    moduleEntry,
  ] }] } } };
  const thread = parseThread(body, { limit: 10, depth: 1, maxChars: 10000 });
  assert.equal(thread.post.id, '999');
  assert.deepEqual(thread.replies.map(reply => [reply.id, reply.depth]), [['2001', 1], ['2002', 1]]);
  const flat = parseThread(body, { limit: 10, depth: 0, maxChars: 10000 });
  assert.equal(flat.replies.length, 0, 'depth 0 keeps only the post');
});

test('a rejected query id is rediscovered once, then reported as a maintainer failure', async () => {
  resetXThreadState();
  let pageReads = 0;
  const { fetcher, calls } = mockRouter(({ url }) => {
    if (url.includes('/status/')) { pageReads += 1; return { text: STATUS_HTML }; }
    return calls.filter(call => call.url.includes('TweetDetail')).length === 1 ? { status: 404 } : { body: conversation(['999']) };
  });
  const thread = await fetchXThread({ id: '999', limit: 5, depth: 2, maxChars: 4000 }, ctx(fetcher));
  assert.equal(thread.post.id, '999');
  assert.equal(pageReads, 2);

  resetXThreadState();
  const failing = mockRouter(({ url }) => (url.includes('/status/') ? { text: STATUS_HTML } : { status: 404 }));
  await assert.rejects(fetchXThread({ id: '999', limit: 5, depth: 2, maxChars: 4000 }, ctx(failing.fetcher)), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.kind, 'protocol');
    assert.match(error.message, /maintainer/i);
    return true;
  });
  assert.equal(failing.calls.filter(call => call.url.includes('TweetDetail')).length, 2);
});

test('expired cookies and a missing operation keep their own error kinds', async () => {
  resetXThreadState();
  const signedOut = mockRouter(() => ({ text: '<script src="https://abs.twimg.com/x-web/x-web/entry-client-logged-out-1.js"></script>' }));
  await assert.rejects(fetchXThread({ id: '999', limit: 5, depth: 2, maxChars: 4000 }, ctx(signedOut.fetcher)), (error: unknown) => {
    assert.equal((error as SearchError).kind, 'authentication');
    return true;
  });

  resetXThreadState();
  const migrated = mockRouter(() => ({ text: '<html>no operation</html>' }));
  await assert.rejects(fetchXThread({ id: '999', limit: 5, depth: 2, maxChars: 4000 }, ctx(migrated.fetcher)), (error: unknown) => {
    assert.equal((error as SearchError).kind, 'protocol');
    assert.match((error as SearchError).message, /TweetDetail/);
    assert.doesNotMatch((error as SearchError).message, /secret-auth/);
    return true;
  });
});

test('an empty conversation is an error, not an empty thread', () => {
  assert.throws(() => parseThread({ data: { threaded_conversation_with_injections_v2: { instructions: [] } } }, { limit: 5, depth: 2, maxChars: 1000 }), /no post in it/);
});
