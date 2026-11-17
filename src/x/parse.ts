import type { Source } from '../types.js';

/**
 * Shapes below follow X's 2026 search response: the timeline arrives as `instructions[]`,
 * each carrying `entries[]`, and a tweet can sit directly on an entry or inside a module's
 * `items[]`. Fields moved into `core`/`note_tweet` over time, so every read has a fallback.
 */
type Node = Record<string, unknown>;

const node = (value: unknown): Node => (value && typeof value === 'object' && !Array.isArray(value) ? value as Node : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export const TITLE_EXCERPT_CHARS = 90;
export const SNIPPET_MAX_CHARS = 400;

export interface ParsedTweet {
  id: string;
  handle?: string;
  text: string;
  createdAt?: string;
  likes: number;
  reposts: number;
  replies: number;
}

/**
 * Find the tweet inside an entry without assuming the nesting. X has moved it between
 * `content.itemContent`, `content.content` and module `items[]` across releases, so the
 * search is structural and bounded rather than a fixed path.
 */
function tweetFromEntry(entry: Node): Node | undefined {
  const queue: unknown[] = [entry];
  for (let step = 0; step < 24 && queue.length > 0; step += 1) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const value = current as Node;
    const results = value.tweet_results;
    if (results && typeof results === 'object') {
      const result = node(results).result;
      if (result && typeof result === 'object') return node(result);
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return undefined;
}

function unwrap(result: Node): Node {
  // Tweets hidden behind a visibility wrapper keep the real payload one level down.
  return result.__typename === 'TweetWithVisibilityResults' ? node(result.tweet) : result;
}

function author(nodeValue: Node): string | undefined {
  const user = node(node(node(nodeValue.core).user_results).result);
  return str(node(user.core).screen_name) ?? str(node(user.legacy).screen_name);
}

function body(nodeValue: Node): string {
  // 2026 shape: the body moved to `details.full_text`; long posts still use note_tweet.
  const note = node(node(nodeValue.note_tweet).note_tweet_results).result;
  return str(node(note).text)
    ?? str(node(nodeValue.details).full_text)
    ?? str(node(nodeValue.legacy).full_text)
    ?? str(nodeValue.text)
    ?? '';
}

function createdAt(nodeValue: Node): string | undefined {
  const millis = node(nodeValue.details).created_at_ms;
  if (typeof millis === 'number' && Number.isFinite(millis)) return new Date(millis).toISOString();
  const raw = str(node(nodeValue.details).created_at) ?? str(node(nodeValue.legacy).created_at) ?? str(nodeValue.created_at);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function parseTweet(result: Node): ParsedTweet | undefined {
  const tweet = unwrap(result);
  const id = str(tweet.rest_id) ?? str(tweet.id_str);
  const text = body(tweet);
  if (!id) return undefined;
  const legacy = node(tweet.legacy);
  const counts = node(tweet.counts);
  return {
    id,
    ...(author(tweet) ? { handle: author(tweet) } : {}),
    text,
    ...(createdAt(tweet) ? { createdAt: createdAt(tweet) } : {}),
    likes: num(counts.favorite_count ?? legacy.favorite_count),
    reposts: num(counts.retweet_count ?? legacy.retweet_count),
    replies: num(counts.reply_count ?? legacy.reply_count),
  };
}

/** Walk the timeline instructions and pull every tweet that has a body worth quoting. */
export function parseInstructions(data: Node, limit: number): ParsedTweet[] {
  const timeline = node(node(node(data.data).search_by_raw_query).search_timeline).timeline;
  const tweets: ParsedTweet[] = [];
  for (const instruction of list(node(timeline).instructions)) {
    for (const entry of list(node(instruction).entries)) {
      const result = tweetFromEntry(node(entry));
      if (!result) continue;
      const parsed = parseTweet(result);
      if (!parsed || parsed.text.trim() === '') continue;
      tweets.push(parsed);
      if (tweets.length >= limit) return tweets;
    }
  }
  return tweets;
}

export function toSource(tweet: ParsedTweet): Source {
  const text = tweet.text.replace(/\s+/g, ' ').trim();
  const source: Source = {
    url: `https://x.com/${tweet.handle ?? 'i/web'}/status/${tweet.id}`,
    title: `${tweet.handle ? `@${tweet.handle}` : 'X post'}: ${text.slice(0, TITLE_EXCERPT_CHARS)}`,
    snippet: text.slice(0, SNIPPET_MAX_CHARS),
  };
  if (tweet.likes + tweet.reposts + tweet.replies > 0) {
    source.summary = `${tweet.likes} likes, ${tweet.reposts} reposts, ${tweet.replies} replies`;
  }
  if (tweet.createdAt) source.publishedAt = tweet.createdAt;
  return source;
}
