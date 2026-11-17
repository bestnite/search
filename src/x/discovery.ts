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

/** Mine the search operation out of a search page document. */
export function findSearchOperation(html: string): SearchOperation | null {
  for (const match of html.matchAll(OPERATION_RE)) {
    const [, queryId, name] = match;
    if (name !== OPERATION_NAME || queryId === undefined) continue;
    const open = html.indexOf('{', (match.index ?? 0) + match[0].length);
    if (open < 0) continue;
    const variables = literalToJson(sliceObject(html, open));
    if (Object.keys(variables).length === 0) continue;
    return { queryId, variables };
  }
  return null;
}

export interface DiscoveryTransport {
  credentials: SessionCredential;
  signal: AbortSignal;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Cached per build: the query id changes with each X deploy, not with each search. */
export class SearchOperationCache {
  private entry: { operation: SearchOperation; loadedAt: number } | null = null;

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS, private readonly now: () => number = Date.now) {}

  reset(): void { this.entry = null; }

  async get(transport: DiscoveryTransport, query: string, fresh = false): Promise<SearchOperation> {
    if (!fresh && this.entry && this.now() - this.entry.loadedAt < this.ttlMs) return this.entry.operation;
    const operation = await discover(transport, query);
    this.entry = { operation, loadedAt: this.now() };
    return operation;
  }
}

async function discover(transport: DiscoveryTransport, query: string): Promise<SearchOperation> {
  const url = `${SEARCH_PAGE}?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
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
  const operation = findSearchOperation(html);
  if (!operation) {
    if (html.includes('entry-client-logged-out')) {
      throw new SearchError('authentication', 'x.com served the signed-out page for these cookies, so the session is no longer live. Sign in to X in a browser and copy both cookies again.');
    }
    throw new SearchError('protocol', `The x.com search page no longer embeds the ${OPERATION_NAME} operation. ${MAINTAINER_ACTION}`);
  }
  // The page also proves the cookies work: it only carries the operation when signed in
  // unless the visitor is authenticated, so no extra probe is needed here.
  void cookieHeader;
  void apiHeaders;
  return operation;
}
