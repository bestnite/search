// Response shapes and local trimming for the Reddit read paths.
//
// gql-fed.reddit.com returns its own field names and a flat, depth-annotated comment forest; the
// oauth.reddit.com REST endpoints return the classic Listing JSON. Both are normalised here into the
// plugin's Source / RedditComment shapes, and both get the same depth, top-level-limit and
// character-budget trimming, so downstream behaviour does not depend on which path ran.

import { SearchError } from '../transport.js';
import type { Source } from '../types.js';

/** Matches the gql PostComments / SearchPosts field names we read. */
export interface GqlCommentNode {
  __typename?: string;
  id?: string;
  authorInfo?: { name?: string | null } | null;
  content?: { markdown?: string | null } | null;
  createdAt?: string | null;
  score?: number | null;
  isRemoved?: boolean | null;
  isAdminTakedown?: boolean | null;
}

export interface GqlTree {
  depth?: number;
  parentId?: string | null;
  more?: { count?: number | null; cursor?: string } | null;
  node?: GqlCommentNode | null;
}

export interface GqlPostNode {
  __typename?: string;
  id?: string;
  title?: string | null;
  postTitle?: string | null;
  authorInfo?: { name?: string | null } | null;
  subreddit?: { name?: string | null } | null;
  score?: number | null;
  commentCount?: number | null;
  createdAt?: string | null;
  permalink?: string | null;
  url?: string | null;
  isSelfPost?: boolean | null;
  content?: { markdown?: string | null } | null;
  media?: { image?: { url?: string | null } | null; gallery?: { items?: Array<{ url?: string | null }> | null } | null } | null;
  preview?: { images?: Array<{ source?: { url?: string | null } | null }> | null } | null;
  urlOverriddenByDest?: string | null;
}

export interface RedditComment {
  author: string;
  score: number;
  body: string;
  createdUtc?: number;
  depth: number;
  replies: RedditComment[];
}

/** A post reduced to the fields this plugin exposes, independent of which endpoint produced it. */
export interface PostData {
  id: string;
  title: string;
  permalink: string;
  url: string;
  author: string;
  score: number;
  commentCount?: number;
  createdUtc?: number;
  selfText?: string;
  /** Pictures the post carries, best effort: a direct link, a gallery, or the preview. */
  images: string[];
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** GraphQL created timestamps look like 2026-10-30T06:10:28.665000+0000; Reddit JSON uses epoch seconds. */
export function isoToEpochSeconds(value: unknown): number | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  const normalized = match
    ? `${match[1]}${match[2] === 'Z' ? 'Z' : match[2]!.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** Canonical permalink URL; never doubles the domain when the input is already absolute. */
export function permalinkUrl(permalink: string, fallbackId = ''): string {
  const raw = permalink.trim();
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      const url = new URL(raw);
      return `https://www.reddit.com${url.pathname}${url.search}`;
    } catch {
      return raw;
    }
  }
  const path = raw === '' ? `/comments/${fallbackId}` : raw.startsWith('/') ? raw : `/${raw}`;
  return `https://www.reddit.com${path}`;
}

/** Accepts a base36 id, a t3_ fullname, or a full thread URL. */
export function normalizeThreadId(input: string): string {
  const raw = input.trim();
  const fromUrl = /\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)/i.exec(raw) ?? /redd\.it\/([a-z0-9]+)/i.exec(raw);
  const candidate = (fromUrl?.[1] ?? raw).replace(/^t3_/i, '').toLowerCase();
  if (!/^[a-z0-9]{1,20}$/.test(candidate)) {
    throw new SearchError('configuration', 'A Reddit thread id must be a base36 id, a t3_ fullname, or a thread URL.');
  }
  return candidate;
}

function summarize(text: string, maxChars = 280): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Self text when the post has any, otherwise the author/score line. */
function snippetFor(post: PostData): string | undefined {
  if (post.selfText && post.selfText.trim() !== '') return summarize(post.selfText);
  const parts = [`by u/${post.author || '[unknown]'}`, `${post.score} points`];
  if (post.commentCount !== undefined) parts.push(`${post.commentCount} comments`);
  return parts.join(' · ');
}

export function toSource(post: PostData): Source {
  const source: Source = {
    url: permalinkUrl(post.permalink, post.id),
    title: post.title || `t3_${post.id}`,
  };
  const snippet = snippetFor(post);
  if (snippet !== undefined) source.snippet = snippet;
  if (post.createdUtc !== undefined) source.publishedAt = new Date(post.createdUtc * 1000).toISOString();
  return source;
}

// ---------------------------------------------------------------------------
// SearchPosts response
// ---------------------------------------------------------------------------

export function searchPostNodes(data: Record<string, unknown>): GqlPostNode[] {
  const search = data.search as { general?: { posts?: { edges?: unknown } | null } | null } | null | undefined;
  const edges = search?.general?.posts?.edges;
  if (!Array.isArray(edges)) {
    throw new SearchError('protocol', 'Reddit returned no search connection; the persisted SearchPosts shape changed.');
  }
  return edges.flatMap((edge) => {
    const node = (edge as { node?: GqlPostNode | null } | null)?.node;
    return node ? [node] : [];
  });
}

/** Media on a GraphQL post: a single picture, a gallery, a preview, or a direct image link. */
function graphqlImages(node: GqlPostNode): string[] {
  const found: string[] = [];
  const direct = str(node.urlOverriddenByDest ?? node.url);
  if (/\.(?:jpe?g|png|gif|webp)(?:\?|$)/i.test(direct)) found.push(direct);
  const single = str(node.media?.image?.url);
  if (single) found.push(single);
  for (const item of node.media?.gallery?.items ?? []) {
    const url = str(item?.url);
    if (url) found.push(url);
  }
  for (const image of node.preview?.images ?? []) {
    const url = str(image?.source?.url).replaceAll('&amp;', '&');
    if (url) found.push(url);
  }
  return [...new Set(found)].slice(0, 10);
}

export function gqlPost(node: GqlPostNode): PostData {
  const id = str(node.id).replace(/^t3_/, '');
  const permalink = str(node.permalink);
  return {
    id,
    title: str(node.title, str(node.postTitle)),
    permalink,
    url: str(node.url, permalink),
    author: str(node.authorInfo?.name, '[deleted]'),
    score: num(node.score) ?? 0,
    commentCount: num(node.commentCount),
    createdUtc: isoToEpochSeconds(node.createdAt),
    selfText: str(node.content?.markdown),
    // The GraphQL node nests media under the legacy shape it was projected from.
    images: graphqlImages(node),
  };
}

// ---------------------------------------------------------------------------
// PostComments response
// ---------------------------------------------------------------------------

export function commentTrees(data: Record<string, unknown>): GqlTree[] {
  const post = data.postInfoById as { commentForest?: { trees?: unknown } | null } | null | undefined;
  const trees = post?.commentForest?.trees;
  if (!Array.isArray(trees)) {
    throw new SearchError('protocol', 'Reddit returned no comment forest; the persisted PostComments shape changed.');
  }
  return trees as GqlTree[];
}

function commentFromNode(node: GqlCommentNode | null | undefined, depth: number): RedditComment | undefined {
  if (!node) return undefined;
  const deleted = node.__typename === 'DeletedComment';
  const body = deleted
    ? '[deleted]'
    : node.isAdminTakedown === true
      ? '[ Removed by Reddit ]'
      : node.isRemoved === true
        ? '[removed]'
        : str(node.content?.markdown);
  const comment: RedditComment = {
    author: deleted || node.isRemoved === true ? '[deleted]' : str(node.authorInfo?.name, '[unknown]'),
    score: num(node.score) ?? 0,
    body,
    depth,
    replies: [],
  };
  const createdUtc = isoToEpochSeconds(node.createdAt);
  if (createdUtc !== undefined) comment.createdUtc = createdUtc;
  return comment;
}

/**
 * Nest the flat, depth-annotated tree list. `maxDepth` counts nesting levels that are kept with the
 * top-level comments as level 1, so depth 1 returns no replies; `limit` caps top-level comments.
 * "more" stubs are skipped: a persisted operation does not hand back the children they stand for.
 */
export function buildCommentTree(trees: GqlTree[], maxDepth: number, limit: number): RedditComment[] {
  const roots: RedditComment[] = [];
  const stack: RedditComment[] = [];
  for (const tree of trees) {
    if (tree.more) continue;
    const level = typeof tree.depth === 'number' && tree.depth >= 0 ? tree.depth : stack.length;
    if (level + 1 > maxDepth) continue;
    const comment = commentFromNode(tree.node, level);
    if (!comment) continue;
    while (stack.length > level) stack.pop();
    const parent = level > 0 ? stack[level - 1] : undefined;
    if (level > 0 && !parent) continue;
    (parent ? parent.replies : roots).push(comment);
    stack.push(comment);
  }
  return roots.slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// oauth.reddit.com REST responses
// ---------------------------------------------------------------------------

interface RestThing {
  kind?: string;
  data?: Record<string, unknown>;
}

function listingChildren(value: unknown): RestThing[] {
  const children = (value as { data?: { children?: unknown } } | null)?.data?.children;
  if (!Array.isArray(children)) {
    throw new SearchError('protocol', 'Reddit returned a listing without children.');
  }
  return children as RestThing[];
}

/** GET /search returns a t3 listing. */
export function restSearchPosts(payload: unknown): PostData[] {
  return listingChildren(payload)
    .filter((thing) => thing.kind === 't3')
    .flatMap((thing) => (thing.data ? [restPost(thing.data)] : []));
}

/** The thread payload is [post listing, comment listing]. */
export function restThreadPost(payload: unknown): Record<string, unknown> {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new SearchError('protocol', 'Reddit returned no post for this thread.');
  }
  const post = listingChildren(payload[0]).find((thing) => thing.kind === 't3');
  if (!post?.data) throw new SearchError('protocol', 'Reddit returned no post for this thread.');
  return post.data;
}

/** Reddit wraps media URLs in HTML entities and offers several shapes depending on the post type. */
function imagesOf(data: Record<string, unknown>): string[] {
  const unescape = (value: string): string => value.replaceAll('&amp;', '&');
  const found: string[] = [];
  const direct = str(data.url_overridden_by_dest) || str(data.url);
  if (/\.(?:jpe?g|png|gif|webp)(?:\?|$)/i.test(direct)) found.push(direct);
  const gallery = data.media_metadata;
  if (gallery && typeof gallery === 'object') {
    for (const item of Object.values(gallery as Record<string, unknown>)) {
      const source = (item as { s?: { u?: unknown; gif?: unknown } } | null)?.s;
      const url = str(source?.u) || str(source?.gif);
      if (url) found.push(unescape(url));
    }
  }
  const preview = (data.preview as { images?: unknown } | undefined)?.images;
  if (Array.isArray(preview)) {
    for (const image of preview) {
      const url = str((image as { source?: { url?: unknown } } | null)?.source?.url);
      if (url) found.push(unescape(url));
    }
  }
  return [...new Set(found)].slice(0, 10);
}

export function restPost(data: Record<string, unknown>): PostData {
  const id = str(data.id);
  const permalink = str(data.permalink);
  return {
    id,
    title: str(data.title),
    permalink,
    url: str(data.url, permalink),
    author: str(data.author, '[deleted]'),
    score: num(data.score) ?? 0,
    commentCount: num(data.num_comments),
    createdUtc: num(data.created_utc),
    selfText: str(data.selftext),
    images: imagesOf(data),
  };
}

/** Convert the already-nested REST comment listing; `replies` is "" or another listing. */
export function restCommentTree(payload: unknown, maxDepth: number, limit: number): RedditComment[] {
  if (!Array.isArray(payload) || payload.length < 2) {
    throw new SearchError('protocol', 'Reddit returned no comment listing for this thread.');
  }
  return restComments(listingChildren(payload[1]), 0, maxDepth).slice(0, Math.max(0, limit));
}

function restComments(children: RestThing[], depth: number, maxDepth: number): RedditComment[] {
  const out: RedditComment[] = [];
  for (const thing of children) {
    if (thing.kind !== 't1' || !thing.data) continue;
    const data = thing.data;
    const comment: RedditComment = {
      author: str(data.author, '[unknown]'),
      score: num(data.score) ?? 0,
      body: str(data.body),
      depth,
      replies: [],
    };
    const createdUtc = num(data.created_utc);
    if (createdUtc !== undefined) comment.createdUtc = createdUtc;
    const replies = data.replies;
    if (depth + 2 <= maxDepth && replies && typeof replies === 'object') {
      comment.replies = restComments(listingChildren(replies), depth + 1, maxDepth);
    }
    out.push(comment);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Character budget
// ---------------------------------------------------------------------------

function flattenComments(comments: RedditComment[]): RedditComment[] {
  const out: RedditComment[] = [];
  for (const comment of comments) {
    out.push(comment);
    out.push(...flattenComments(comment.replies));
  }
  return out;
}

/**
 * Trim comment bodies from the end until the total body length fits `maxChars`. Comment structure
 * and post metadata are kept. Returns whether anything was cut.
 */
export function trimBodies(comments: RedditComment[], maxChars: number): boolean {
  const flat = flattenComments(comments);
  let total = flat.reduce((sum, comment) => sum + comment.body.length, 0);
  if (total <= maxChars) return false;
  for (const comment of [...flat].reverse()) {
    if (total <= maxChars) break;
    const excess = total - maxChars;
    if (excess >= comment.body.length) {
      total -= comment.body.length;
      comment.body = '';
    } else {
      comment.body = comment.body.slice(0, comment.body.length - excess);
      total = maxChars;
    }
  }
  return true;
}
