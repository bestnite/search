// X session-cookie search path, exercised entirely through an injected fetch: no real network.
//
// The mock reimplements the four-page signer chain (home -> entry-client -> sign importer -> sign
// module) and the main.js bundle the queryId table is read from, so the whole reverse-engineered
// path runs offline. Every constant that the implementation exports is imported rather than
// restated, so a wrong constant fails on behaviour instead of on a duplicated literal.

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchError } from '../src/transport.js';
import { GRAPHQL_BASE, USER_AGENT, WEB_BEARER } from '../src/x/auth.js';
import { HOME_URL, extractOperations } from '../src/x/operations.js';
import {
  ADDITIONAL_RANDOM_NUMBER,
  ClientTransaction,
  TIME_EPOCH_SECONDS,
  payloadOf,
  textFetcher,
} from '../src/x/tid.js';
import { resetXSessionState, searchXSession, type SessionContext } from '../src/x/session.js';
import type { Source } from '../src/types.js';

// Distinctive values so a leak into any message or result is unambiguous.
const AUTH_TOKEN = 'AUTH-TOKEN-7f3a9c-do-not-print';
const CT0 = 'CT0-csrf-41bd2e-do-not-print';

// The mock queryId table's SearchTimeline entry.
const QUERY_ID = 'BYppgupFFS2yqVmmRNjlsw';
const ROTATED_QUERY_ID = 'RotatedQueryId00000001a';
const FEATURE_SWITCHES = ['rweb_video_screen_enabled', 'responsive_web_tweet_article_tweet_consumption_enabled'];
const FIELD_TOGGLES = ['withArticleRichRelevance'];

// 48 verification-key bytes; the algorithm reads bytes 5, 27%, 4 and 12 out of it.
const KEY_BYTES = Array.from({ length: 48 }, (_, index) => (index * 37 + 11) % 256);
const SITE_KEY = Buffer.from(KEY_BYTES).toString('base64');

const ENTRY_SCRIPT_URL = 'https://abs.twimg.com/responsive-web/client-web/entry-client-abcdef.js';
const IMPORTER_SCRIPT_URL =
  'https://abs.twimg.com/responsive-web/client-web/client-transaction-id-plugin-abc123.js';
const SIGN_SCRIPT_URL = 'https://abs.twimg.com/responsive-web/client-web/sign.o-xyz789.js';
const MAIN_BUNDLE_URL = 'https://abs.twimg.com/responsive-web/client-web/main.abc123.js';

// --- fixtures ---------------------------------------------------------------

/** One loading-x-anim frame with 16 cubic-bezier rows, so any key-derived row index is in range. */
function animationFrame(index: number): string {
  const rows = Array.from(
    { length: 16 },
    (_, row) => ` ${(row * 13) % 200},${(row * 7) % 255},10,20,30,40,50,60,70,5,15`,
  );
  // Only the second <path> is treated as the animation; the first is the X logo.
  return `<svg id="loading-x-anim-${String(index)}"><path d="M0,0 L1,1"/><path d="M 10,30 C${rows.join('C')}"/></svg>`;
}

/** The x.com home page the signer reads: meta key, four anim frames, entry-client script. */
function signerHomePage(): string {
  return [
    '<!doctype html><html><head>',
    `<meta name="twitter-site-verification" content="${SITE_KEY}">`,
    '</head><body>',
    [0, 1, 2, 3].map(animationFrame).join(''),
    `<script src="${ENTRY_SCRIPT_URL}"></script>`,
    '</body></html>',
  ].join('');
}

/** A home page that no longer leads to the sign module: the page layout changed. */
function brokenSignerHomePage(): string {
  return '<!doctype html><html><head></head><body><div id="react-root"></div></body></html>';
}

/** The home page the queryId reader fetches; it only has to point at main.js. */
function operationsHomePage(): string {
  return `<!doctype html><html><body><script src="${MAIN_BUNDLE_URL}"></script></body></html>`;
}

const ENTRY_SCRIPT_TEXT = `export default () => import("./client-transaction-id-plugin-abc123.js");`;
const IMPORTER_SCRIPT_TEXT = `export const load = () => import("./sign.o-xyz789.js");`;
// The (e[27], 16)+(e[4], 16)+(e[12], 16) shape the KEY_BYTE extractor looks for.
const SIGN_SCRIPT_TEXT = `function s(e){return (e[27],16)+(e[4],16)+(e[12],16)}export{s as t};`;

/** A main.js fragment carrying the operation table in the shape X emits. */
function mainBundle(queryId: string): string {
  const switches = FEATURE_SWITCHES.map((name) => `"${name}"`).join(',');
  const toggles = FIELD_TOGGLES.map((name) => `"${name}"`).join(',');
  return [
    'self.webpackChunkwebpack=[];',
    `{queryId:"${queryId}",operationName:"SearchTimeline",operationType:"Query",metadata:{featureSwitches:[${switches}],fieldToggles:[${toggles}]}}`,
    `{queryId:"UserByScreenNameAAA",operationName:"UserByScreenName",operationType:"Query",metadata:{featureSwitches:["rweb_video_screen_enabled"],fieldToggles:[]}}`,
    ';',
  ].join('');
}

/** A SearchTimeline body: one long post (note_tweet) and one result with no author handle. */
function searchPayload(): unknown {
  return {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  {
                    entryId: 'tweet-1790000000000000001',
                    content: {
                      itemContent: {
                        tweet_results: {
                          result: {
                            __typename: 'TweetWithVisibilityResults',
                            tweet: {
                              rest_id: '1790000000000000001',
                              legacy: {
                                full_text: 'short legacy body',
                                created_at: 'Wed Oct 10 20:19:24 +0000 2018',
                                favorite_count: 12,
                                retweet_count: 3,
                                reply_count: 1,
                              },
                              note_tweet: {
                                note_tweet_results: {
                                  result: { text: 'Long body\nwith a line break' },
                                },
                              },
                              core: {
                                user_results: {
                                  result: {
                                    __typename: 'User',
                                    rest_id: 'u-1',
                                    core: { screen_name: 'alice', name: 'Alice' },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  {
                    entryId: 'tweet-1790000000000000002',
                    content: {
                      itemContent: {
                        tweet_results: {
                          result: {
                            rest_id: '1790000000000000002',
                            legacy: { full_text: 'no author on this one' },
                          },
                        },
                      },
                    },
                  },
                  { entryId: 'cursor-bottom-1', content: { value: 'CURSOR_TOKEN' } },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

// --- mock transport ---------------------------------------------------------

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

interface Routes {
  /** Body of the queryId reader's home page. */
  operationsHome?: () => string;
  /** Body of main.js as of the current extraction. */
  bundle?: () => string;
  /** Signer home page per build attempt (1-based); null returns HTTP 500. */
  signerHome?: (build: number) => string | null;
  /** GraphQL answer, one per real attempt. */
  search?: (url: string) => Response | Promise<Response>;
}

function respond(body: string, contentType: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

function routesFor(routes: Routes): (call: Call) => Response | Promise<Response> {
  let signerBuilds = 0;
  return (call: Call): Response | Promise<Response> => {
    const { url } = call;
    // Both the queryId reader and the signer fetch x.com/home; only the first sends the cookie.
    if (url === HOME_URL) {
      if (call.headers.cookie) return respond((routes.operationsHome ?? operationsHomePage)(), 'text/html');
      signerBuilds += 1;
      const page = (routes.signerHome ?? (() => signerHomePage()))(signerBuilds);
      return page === null ? new Response('', { status: 500 }) : respond(page, 'text/html');
    }
    if (url.includes('/main.')) return respond((routes.bundle ?? (() => mainBundle(QUERY_ID)))(), 'text/javascript');
    if (url.includes('entry-client')) return respond(ENTRY_SCRIPT_TEXT, 'text/javascript');
    if (url.includes('client-transaction-id-plugin')) return respond(IMPORTER_SCRIPT_TEXT, 'text/javascript');
    if (url.includes('sign.o-')) return respond(SIGN_SCRIPT_TEXT, 'text/javascript');
    if (url.startsWith(GRAPHQL_BASE)) {
      return (routes.search ?? (() => Response.json(searchPayload())))(url);
    }
    return new Response('', { status: 404 });
  };
}

function mockFetch(routes: Routes): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const handle = routesFor(routes);
  const fetchImpl = (async (input: unknown, init: RequestInit | undefined) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return handle(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function context(credentials: { authToken: string; ct0: string }, fetchImpl: typeof fetch): SessionContext {
  return { credentials, signal: new AbortController().signal, timeoutMs: 5000, fetch: fetchImpl };
}

function graphqlCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.url.startsWith(GRAPHQL_BASE));
}

function homeCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.url === HOME_URL && call.headers.cookie !== undefined);
}

/** A rejection matcher that also proves no secret reached the message. */
function failure(kind: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof SearchError, `expected a SearchError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    for (const secret of [AUTH_TOKEN, CT0, WEB_BEARER]) {
      assert.ok(!error.message.includes(secret), 'the error message leaked a secret');
    }
    return true;
  };
}

beforeEach(() => {
  resetXSessionState();
});

// --- tests ------------------------------------------------------------------

test('a missing cookie pair fails as configuration before any request is sent', async () => {
  const { calls, fetchImpl } = mockFetch({});

  await assert.rejects(
    () => searchXSession({ query: 'graphene', maxResults: 5 }, context({ authToken: '', ct0: CT0 }, fetchImpl)),
    failure('configuration'),
  );
  await assert.rejects(
    () => searchXSession({ query: 'graphene', maxResults: 5 }, context({ authToken: AUTH_TOKEN, ct0: '' }, fetchImpl)),
    failure('configuration'),
  );
  assert.equal(calls.length, 0);
});

test('401 and 403 are authentication failures whose message never carries the cookie', async () => {
  for (const status of [401, 403]) {
    resetXSessionState();
    const { fetchImpl } = mockFetch({
      search: () => new Response(JSON.stringify({ code: status === 403 ? 353 : 32 }), { status }),
    });
    await assert.rejects(
      () => searchXSession({ query: 'graphene', maxResults: 5 }, context({ authToken: AUTH_TOKEN, ct0: CT0 }, fetchImpl)),
      (error: unknown) => {
        failure('authentication')(error);
        assert.match((error as SearchError).message, /auth_token/);
        assert.match((error as SearchError).message, /ct0/);
        assert.equal((error as SearchError).status, status);
        return true;
      },
    );
  }
});

test('a normal search parses x.com permalinks with the queryId read from the mocked bundle', async () => {
  const { calls, fetchImpl } = mockFetch({ search: () => Response.json(searchPayload()) });

  const sources = await searchXSession(
    { query: 'graphene', maxResults: 5 },
    context({ authToken: AUTH_TOKEN, ct0: CT0 }, fetchImpl),
  );

  // The operation table really came out of the mocked main.js.
  assert.equal(extractOperations(mainBundle(QUERY_ID)).get('SearchTimeline')?.queryId, QUERY_ID);

  const [search] = graphqlCalls(calls);
  assert.ok(search, 'a GraphQL request was sent');
  assert.ok(
    search.url.startsWith(`${GRAPHQL_BASE}/${QUERY_ID}/SearchTimeline?`),
    `unexpected search endpoint: ${search.url}`,
  );

  const params = new URL(search.url).searchParams;
  // The SearchTimeline variables keep the upstream shape exactly.
  assert.deepEqual(JSON.parse(params.get('variables') ?? '{}'), {
    rawQuery: 'graphene',
    count: 5,
    product: 'Latest',
    querySource: 'typed_query',
  });
  const features = JSON.parse(params.get('features') ?? '{}');
  for (const name of FEATURE_SWITCHES) assert.equal(features[name], true);
  assert.deepEqual(JSON.parse(params.get('fieldToggles') ?? '{}'), { withArticleRichRelevance: true });

  // Signed request headers: bearer, csrf token, transaction id.
  assert.equal(search.headers.authorization, `Bearer ${WEB_BEARER}`);
  assert.equal(search.headers['x-csrf-token'], CT0);
  assert.equal(search.headers['x-twitter-auth-type'], 'OAuth2Session');
  assert.equal(search.headers['user-agent'], USER_AGENT);
  assert.equal(search.headers['x-client-transaction-id']?.length, 94);

  // Mapping to Source.
  assert.equal(sources.length, 2);
  assert.equal(sources[0]?.url, 'https://x.com/alice/status/1790000000000000001');
  assert.equal(sources[0]?.title, '@alice: Long body with a line break');
  assert.equal(sources[0]?.snippet, 'Long body with a line break');
  assert.equal(sources[0]?.publishedAt, '2018-10-10T20:19:24.000Z');
  assert.equal(sources[0]?.summary, '12 likes, 3 reposts, 1 replies');
  // No handle in the payload: the permalink falls back to the /i/web form.
  assert.equal(sources[1]?.url, 'https://x.com/i/web/status/1790000000000000002');
  assert.equal(sources[1]?.title, 'X post: no author on this one');
});

test('a rotated queryId is repaired by re-reading the operation table', async () => {
  let bundle = mainBundle(QUERY_ID);
  const { calls, fetchImpl } = mockFetch({
    bundle: () => bundle,
    search: (url) => {
      if (url.includes(`/${QUERY_ID}/`)) {
        bundle = mainBundle(ROTATED_QUERY_ID);
        return new Response('{"errors":[{"code":34}]}', { status: 404 });
      }
      return Response.json(searchPayload());
    },
  });

  const sources = await searchXSession(
    { query: 'graphene', maxResults: 5 },
    context({ authToken: AUTH_TOKEN, ct0: CT0 }, fetchImpl),
  );

  const attempts = graphqlCalls(calls);
  assert.equal(attempts.length, 2, 'one stale attempt and one repaired attempt');
  assert.ok(attempts[0]?.url.includes(`/${QUERY_ID}/`));
  assert.ok(attempts[1]?.url.includes(`/${ROTATED_QUERY_ID}/`), 'the retry used the refreshed queryId');
  assert.equal(homeCalls(calls).length, 2, 'the operation table was re-extracted exactly once');
  assert.equal(sources.length, 2);
});

test('a stale answer that survives both repairs is a protocol failure naming the maintainer', async () => {
  const { calls, fetchImpl } = mockFetch({
    // The table re-extraction succeeds, so only the signing chain is left to blame.
    bundle: () => mainBundle(QUERY_ID),
    // Second signer build: X changed the page and no key can be derived any more.
    signerHome: (build) => (build === 1 ? signerHomePage() : brokenSignerHomePage()),
    search: () => new Response('{"errors":[{"code":34}]}', { status: 404 }),
  });

  await assert.rejects(
    () =>
      searchXSession({ query: 'graphene', maxResults: 5 }, context({ authToken: AUTH_TOKEN, ct0: CT0 }, fetchImpl)),
    (error: unknown) => {
      failure('protocol')(error);
      const message = (error as SearchError).message;
      assert.match(message, /maintainer/i, 'the message must say who can fix this');
      assert.match(message, /signer/i, 'the message must name the signing chain as the cause');
      return true;
    },
  );

  // Two attempts used the signer, the third rebuilt it: three requests for two distinct builds.
  assert.equal(graphqlCalls(calls).length, 2);
  assert.equal(homeCalls(calls).length, 2, 'one extraction plus one re-extraction before the retry');
});

test('429 is a rate-limit failure and is not retried', async () => {
  const { calls, fetchImpl } = mockFetch({
    search: () => new Response(JSON.stringify({ errors: [{ code: 88 }] }), { status: 429 }),
  });

  await assert.rejects(
    () =>
      searchXSession({ query: 'graphene', maxResults: 5 }, context({ authToken: AUTH_TOKEN, ct0: CT0 }, fetchImpl)),
    failure('rate-limit'),
  );
  assert.equal(graphqlCalls(calls).length, 1);
});

test('results never carry the cookie pair or the bearer', async () => {
  const { fetchImpl } = mockFetch({ search: () => Response.json(searchPayload()) });
  const sources: Source[] = await searchXSession(
    { query: 'graphene', maxResults: 5 },
    context({ authToken: AUTH_TOKEN, ct0: CT0 }, fetchImpl),
  );
  const serialized = JSON.stringify(sources);
  for (const secret of [AUTH_TOKEN, CT0, WEB_BEARER]) {
    assert.ok(!serialized.includes(secret), 'a result leaked a secret');
  }
});

test('the ported signer produces the documented 70-byte, 94-character transaction id', async () => {
  const { calls, fetchImpl } = mockFetch({});
  const signer = await ClientTransaction.initialize(
    textFetcher({ fetchImpl, signal: new AbortController().signal, timeoutMs: 5000 }),
  );

  // The four-page chain was really walked.
  assert.deepEqual(
    calls.map((call) => call.url),
    [HOME_URL, ENTRY_SCRIPT_URL, IMPORTER_SCRIPT_URL, SIGN_SCRIPT_URL],
  );

  const now = new Date('2026-01-01T00:00:00Z');
  const path = `/i/api/graphql/${QUERY_ID}/SearchTimeline`;
  const transactionId = signer.generateTransactionId('GET', path, now);

  assert.equal(transactionId.length, 94);
  assert.equal(Buffer.from(transactionId, 'base64').length, 70);

  const payload = payloadOf(transactionId);
  assert.equal(payload.length, 69);
  assert.deepEqual([...payload.subarray(0, 48)], KEY_BYTES, 'the 48-byte site key leads the payload');
  const timeNow = Math.floor((now.getTime() - TIME_EPOCH_SECONDS * 1000) / 1000);
  assert.deepEqual(
    [...payload.subarray(48, 52)],
    [0, 1, 2, 3].map((shift) => (timeNow >> (shift * 8)) & 0xff),
    'timeNow is 4 little-endian bytes',
  );
  assert.equal(payload[68], ADDITIONAL_RANDOM_NUMBER);

  // Same instant and path, different mask byte: the payload is stable, the id is not.
  const again = payloadOf(signer.generateTransactionId('GET', path, now));
  assert.deepEqual(again, payload);
  assert.notEqual(signer.generateTransactionId('GET', path, now), transactionId);
});
