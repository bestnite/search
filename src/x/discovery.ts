import { SearchError } from '../transport.js';
import {
  MAINTAINER_ACTION,
  SEARCH_PAGE,
  type SessionCredential,
  apiHeaders,
  authFailure,
  cookieHeader,
  httpFailure,
  mapThrown,
  pageHeaders,
  requestSignal,
} from './auth.js';

/**
 * X's web app executes search server-side and streams the operation into the search
 * page: `{id:"<queryId>",name:"SearchByRawQuery",variables:{...}}`. Reading that pair
 * out of the document is enough to call the endpoint directly, so nothing here touches
 * the JS bundles or the old transaction-id signer.
 */
export interface SearchOperation {
  queryId: string;
  /** Variables as the site sends them, including its `__relay_internal__pv__*` switches. */
  variables: Record<string, unknown>;
}

export const OPERATION_NAME = 'SearchByRawQuery';
const DEFAULT_TTL_MS = 10 * 60 * 1000;

const OPERATION_RE = /id:"([A-Za-z0-9_-]{10,44})",name:"([A-Za-z][A-Za-z0-9_]*)",variables:/g;

/** Turn the site's JS literal into JSON: bare keys, `!0`/`!1`, and `$R[n]` back-references. */
export function literalToJson(literal: string): Record<string, unknown> {
  let text = literal.trim();
  text = text.replace(/!0\b/g, 'true').replace(/!1\b/g, 'false').replace(/:void 0\b/g, ':null');
  text = text.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');
  // A value that points at another serialized slot cannot be resolved without the whole graph.
  text = text.replace(/:\s*\$R\[\d+\]/g, ':null');
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Extract the braced literal that starts at `start`, tolerating strings with braces. */
function sliceObject(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
}

/** Read one JS string literal starting at the opening quote, honouring escapes. */
function scanString(source: string, quoteAt: number): { value: string; end: number } | null {
  const quote = source[quoteAt];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let value = '';
  for (let index = quoteAt + 1; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '\\') { const next = source[index + 1]; if (next === undefined) return null; value += next; index += 1; continue; }
    if (char === quote) return { value, end: index };
    value += char;
  }
  return null;
}

/**
 * Shape two: `{kind:0, key:"<queryId>{<json as an escaped string>}", name:"<Operation>"}`.
 * The status page serializes operations this way, while the search page uses object variables.
 */
export function findKeyedOperation(html: string, operationName: string): SearchOperation | null {
  const marker = `,name:"${operationName}"`;
  for (let at = html.indexOf(marker); at >= 0; at = html.indexOf(marker, at + marker.length)) {
    const keyAt = html.lastIndexOf('key:"', at);
    if (keyAt < 0 || at - keyAt > 20_000) continue;
    const literal = scanString(html, keyAt + 4);
    if (!literal) continue;
    const braceAt = literal.value.indexOf('{');
    if (braceAt < 0) continue;
    const queryId = literal.value.slice(0, braceAt).trim();
    if (!/^[A-Za-z0-9_-]{10,44}$/.test(queryId)) continue;
    const variables = literalToJson(literal.value.slice(braceAt));
    if (Object.keys(variables).length === 0) continue;
    return { queryId, variables };
  }
  return null;
}

/** Mine one operation out of an X document, tolerating either serialized shape. */
export function findOperation(html: string, operationName: string): SearchOperation | null {
  for (const match of html.matchAll(OPERATION_RE)) {
    const [, queryId, name] = match;
    if (name !== operationName || queryId === undefined) continue;
    const open = html.indexOf('{', (match.index ?? 0) + match[0].length);
    if (open < 0) continue;
    const variables = literalToJson(sliceObject(html, open));
    if (Object.keys(variables).length === 0) continue;
    return { queryId, variables };
  }
  return findKeyedOperation(html, operationName);
}

/** Mine the search operation out of a search page document. */
export function findSearchOperation(html: string): SearchOperation | null {
  return findOperation(html, OPERATION_NAME);
}

export interface DiscoveryTransport {
  credentials: SessionCredential;
  signal: AbortSignal;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface DiscoveryTarget {
  /** Page whose document embeds the operation. */
  pageUrl: string;
  operationName: string;
}

/** Cached per build: query ids change with each X deploy, not with each request. */
export class SearchOperationCache {
  private entries = new Map<string, { operation: SearchOperation; loadedAt: number }>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS, private readonly now: () => number = Date.now) {}

  reset(): void { this.entries.clear(); }

  async get(transport: DiscoveryTransport, target: DiscoveryTarget, fresh = false): Promise<SearchOperation> {
    // The query id belongs to the build, not to the query or the post, so one entry per operation.
    const key = target.operationName;
    const cached = this.entries.get(key);
    if (!fresh && cached && this.now() - cached.loadedAt < this.ttlMs) return cached.operation;
    const operation = await discover(transport, target);
    this.entries.set(key, { operation, loadedAt: this.now() });
    return operation;
  }
}

/** Page URL that carries a single post's conversation. */
export function statusUrl(id: string): string {
  return id.includes('/') ? id : `https://x.com/i/web/status/${id}`;
}

export async function discover(transport: DiscoveryTransport, target: DiscoveryTarget): Promise<SearchOperation> {
  const url = target.pageUrl;
  const fetcher = transport.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: pageHeaders(transport.credentials),
      redirect: 'follow',
      signal: requestSignal(transport.signal, transport.timeoutMs),
    });
  } catch (error) {
    throw mapThrown(error, transport.signal, transport.timeoutMs, 'the x.com search page');
  }
  if (response.status === 401 || response.status === 403) throw authFailure(response.status);
  if (response.status === 429) throw new SearchError('rate-limit', 'X rate limit reached while reading the search page.', 429);
  if (!response.ok) throw httpFailure(response.status, 'the x.com search page');
  let html: string;
  try {
    html = await response.text();
  } catch (error) {
    throw mapThrown(error, transport.signal, transport.timeoutMs, 'the x.com search page');
  }
  const operation = findOperation(html, target.operationName);
  if (!operation) {
    if (html.includes('entry-client-logged-out')) {
      throw new SearchError('authentication', 'x.com served the signed-out page for these cookies, so the session is no longer live. Sign in to X in a browser and copy both cookies again.');
    }
    throw new SearchError('protocol', `The x.com page no longer embeds the ${target.operationName} operation. ${MAINTAINER_ACTION}`);
  }
  // The page also proves the cookies work: it only carries the operation when signed in
  // unless the visitor is authenticated, so no extra probe is needed here.
  void cookieHeader;
  void apiHeaders;
  return operation;
}
