// SearchTimeline payload -> the plugin's Source shape.
//
// Ported from bestnite/x-mcp src/x/parse.ts, restricted to the search path (no timelines, users,
// trends or conversations). The three shapes below are preserved rather than tidied because they
// are exactly what moved in the past:
//   - a tweet may be wrapped in TweetWithVisibilityResults;
//   - a long post keeps its body in note_tweet, not legacy.full_text;
//   - screen_name/name/verification moved from legacy.* into core.* (both are read, core first).
//
// The field paths here are the reverse-engineered surface: X can rename any of them, which shows up
// as an empty result set or a missing author, never as an HTTP error.

import { SearchError } from '../transport.js';
import type { Source } from '../types.js';

export interface AuthorSummary {
  id: string;
  username: string;
  name: string;
  verified: boolean;
}

export interface Tweet {
  id: string;
  url: string;
  text: string;
  createdAt?: string;
  author?: AuthorSummary;
  metrics: { likes: number; retweets: number; replies: number; quotes: number };
}

export interface TweetPage {
  tweets: Tweet[];
  nextCursor?: string;
}

// The payload is deeply nested and versioned; readers narrow at the point of use, like upstream.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/** Author handle is optional: without it the permalink falls back to the /i/web form. */
function tweetUrl(username: string | undefined, id: string): string {
  return username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/web/status/${id}`;
}

/** X's "Wed Oct 10 20:19:24 +0000 2018" -> ISO 8601. */
export function toIsoDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function verified(user: Node): boolean {
  const verification = user?.verification ?? {};
  const legacy = user?.legacy ?? {};
  const verifiedType: string | undefined = verification.verified_type;
  return (
    Boolean(verification.verified) ||
    Boolean(legacy.verified) ||
    Boolean(verifiedType && verifiedType !== 'None')
  );
}

/**
 * User object reduced to what a search result needs. X's 2026 layout keeps counts and the handle in
 * top-level objects; the legacy layout keeps them in legacy.*. Both are read.
 */
export function parseUserResult(result: Node): AuthorSummary | null {
  const user = result?.__typename === 'UserWithVisibilityResults' ? result.user : result;
  if (!user || typeof user.rest_id !== 'string') return null;

  const core = user.core ?? {};
  const legacy = user.legacy ?? {};
  const username: string | undefined = core.screen_name ?? legacy.screen_name;
  if (!username) return null;

  return {
    id: user.rest_id,
    username,
    name: core.name ?? legacy.name ?? username,
    verified: verified(user),
  };
}

function parseAuthor(result: Node): AuthorSummary | undefined {
  return parseUserResult(result?.core?.user_results?.result) ?? undefined;
}

export function parseTweetResult(input: Node): Tweet | null {
  if (!input) return null;
  // Visibility wrapper.
  const result = input.__typename === 'TweetWithVisibilityResults' ? input.tweet : input;
  if (!result || typeof result.rest_id !== 'string') return null;

  const legacy = result.legacy ?? {};
  // Long posts keep the body here; legacy.full_text is truncated for them.
  const noteText: string | undefined = result.note_tweet?.note_tweet_results?.result?.text;
  const text: string = noteText ?? legacy.full_text ?? '';

  const author = parseAuthor(result);
  return {
    id: result.rest_id,
    url: tweetUrl(author?.username, result.rest_id),
    text,
    createdAt: toIsoDate(legacy.created_at),
    author,
    metrics: {
      likes: Number(legacy.favorite_count ?? 0),
      retweets: Number(legacy.retweet_count ?? 0),
      replies: Number(legacy.reply_count ?? 0),
      quotes: Number(legacy.quote_count ?? 0),
    },
  };
}

/** Walk timeline instructions, collecting tweets and the bottom cursor. */
export function parseTimelineInstructions(instructions: Node): TweetPage {
  const tweets: Tweet[] = [];
  let nextCursor: string | undefined;

  for (const instruction of instructions ?? []) {
    for (const entry of instruction?.entries ?? []) {
      const entryId: string = entry?.entryId ?? '';

      if (entryId.startsWith('cursor-bottom') || entryId.startsWith('cursor-showMore')) {
        const value = entry?.content?.value;
        if (typeof value === 'string' && value) nextCursor = value;
        continue;
      }

      // A single tweet entry.
      const single =
        entry?.content?.itemContent?.tweet_results?.result ??
        entry?.content?.item?.itemContent?.tweet_results?.result;
      if (single) {
        const tweet = parseTweetResult(single);
        if (tweet) tweets.push(tweet);
        continue;
      }

      // A module entry holding several tweets (promoted clusters, conversations).
      for (const item of entry?.content?.items ?? []) {
        const tweet = parseTweetResult(item?.item?.itemContent?.tweet_results?.result);
        if (tweet) tweets.push(tweet);
      }
    }
  }

  return { tweets, nextCursor };
}

/** Extract the tweets of a SearchTimeline response body. */
export function parseSearchInstructions(data: Node): Tweet[] {
  const instructions = data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
  if (!Array.isArray(instructions)) {
    throw new SearchError(
      'protocol',
      'X returned no search timeline for this query; the SearchTimeline response shape may have changed.',
    );
  }
  return parseTimelineInstructions(instructions).tweets;
}

/** Title excerpt length: enough to identify the post, short enough for a result list. */
const TITLE_EXCERPT_CHARS = 90;
/** Snippet is a preview, not the archive; the permalink carries the full text. */
const SNIPPET_MAX_CHARS = 400;

/** One tweet as a search result: permalink, handle + preview, single-line body, ISO timestamp. */
export function toSource(tweet: Tweet): Source {
  const text = tweet.text.replace(/\s+/g, ' ').trim();
  const handle = tweet.author?.username;
  const source: Source = {
    url: tweet.url,
    title: `${handle ? `@${handle}` : 'X post'}: ${text.slice(0, TITLE_EXCERPT_CHARS)}`,
  };
  if (text !== '') source.snippet = text.slice(0, SNIPPET_MAX_CHARS);
  const { likes, retweets, replies } = tweet.metrics;
  if (likes + retweets + replies > 0) {
    source.summary = `${String(likes)} likes, ${String(retweets)} reposts, ${String(replies)} replies`;
  }
  if (tweet.createdAt !== undefined) source.publishedAt = tweet.createdAt;
  return source;
}
