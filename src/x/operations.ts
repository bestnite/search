// queryId / feature-switch extraction from the x.com front-end bundle.
//
// Ported from bestnite/x-mcp src/x/operations.ts. X rotates queryIds on roughly a three-week cycle,
// so hardcoding one is a self-inflicted outage. The bundle carries entries that look like:
//
//   {queryId:"BYppgupFFS2yqVmmRNjlsw",operationName:"SearchTimeline",operationType:"query",
//    metadata:{featureSwitches:[...],fieldToggles:[...]}}
//
// so the table is read off main.js at first use, cached, and re-read whenever the API says the
// queryId is stale. Extracting an empty table is a protocol failure, never a silent retry.

import { SearchError } from '../transport.js';
import {
  MAINTAINER_ACTION,
  authFailure,
  httpFailure,
  mapThrown,
  requestSignal,
  webHeaders,
  type XTransport,
} from './auth.js';

export interface Operation {
  queryId: string;
  operationName: string;
  operationType: string;
  features: Record<string, boolean>;
  fieldToggles: string[];
}

export const OPERATION_RE =
  /queryId:"([\w-]+)",operationName:"(\w+)",operationType:"(\w+)",metadata:\{featureSwitches:\[([^\]]*)\],fieldToggles:\[([^\]]*)\]\}/g;

export const MAIN_BUNDLE_RE = /https:\/\/abs\.twimg\.com\/[^"'\s]+\/main\.[\w-]+\.js/g;

export const HOME_URL = 'https://x.com/home';

/** Re-read interval for the table. Well under X's rotation cadence, so a rotation costs one miss. */
export const OPERATIONS_TTL_MS = 6 * 60 * 60 * 1000;

/** Slice every operation out of a bundle's text. */
export function extractOperations(bundle: string): Map<string, Operation> {
  const operations = new Map<string, Operation>();
  const listOf = (raw: string): string[] =>
    raw.trim() ? [...raw.matchAll(/"([^"]+)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]])) : [];

  for (const match of bundle.matchAll(OPERATION_RE)) {
    const queryId = match[1];
    const operationName = match[2];
    const operationType = match[3];
    if (queryId === undefined || operationName === undefined || operationType === undefined) continue;
    operations.set(operationName, {
      queryId,
      operationName,
      operationType,
      // Upstream marks every switch true: X only checks that the key exists and is a boolean, so
      // passing the whole list costs nothing and the operation never disagrees on a name.
      features: Object.fromEntries(listOf(match[4] ?? '').map((name) => [name, true])),
      fieldToggles: listOf(match[5] ?? ''),
    });
  }
  return operations;
}

export class OperationsRegistry {
  private operations = new Map<string, Operation>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(private readonly ttlMs: number = OPERATIONS_TTL_MS) {}

  get size(): number {
    return this.operations.size;
  }

  /** Look one operation up, extracting the table first if it is missing or stale. */
  async get(name: string, transport: XTransport): Promise<Operation> {
    if (this.isStale()) await this.refresh(false, transport);
    const found = this.operations.get(name);
    if (found) return found;

    // The bundle may simply not have listed it on that load; force one more extraction before
    // declaring the operation gone.
    await this.refresh(true, transport);
    const retried = this.operations.get(name);
    if (retried) return retried;
    throw new SearchError(
      'protocol',
      `The X operation ${name} is not in the current x.com bundle (${this.operations.size} operations parsed); it may have been renamed or removed. ${MAINTAINER_ACTION}`,
    );
  }

  /** Drop the cached table and re-extract; concurrent callers share one load. */
  async refresh(force = false, transport: XTransport): Promise<void> {
    if (!force && !this.isStale()) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const bundle = await this.fetchMainBundle(transport);
      const operations = extractOperations(bundle);
      if (operations.size === 0) {
        throw new SearchError(
          'protocol',
          `No operations were found in main.js (${bundle.length} characters); the bundle layout changed. ${MAINTAINER_ACTION}`,
        );
      }
      this.operations = operations;
      this.loadedAt = Date.now();
    })();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private isStale(): boolean {
    return this.operations.size === 0 || Date.now() - this.loadedAt > this.ttlMs;
  }

  /** Home page -> main.js. Both reads need the cookie, or the answer is the login wall. */
  private async fetchMainBundle(transport: XTransport): Promise<string> {
    const html = await this.fetchText(HOME_URL, transport, 'x.com/home');
    const bundleUrl = [...new Set([...html.matchAll(MAIN_BUNDLE_RE)].map((m) => m[0]))][0];
    if (bundleUrl === undefined) {
      // A signed-out X serves a different front end (x-web/entry-client-logged-out-*), and that is
      // about the session, not about this adapter, so the two cases must not share one message.
      if (html.includes('entry-client-logged-out') || /\/x-web\//.test(html)) {
        throw new SearchError(
          'authentication',
          'x.com answered with the signed-out page, so the stored auth_token and ct0 are no longer a live session. Sign in to X in a browser and copy both cookies again.',
        );
      }
      throw new SearchError(
        'protocol',
        `Could not find main.js in the x.com home page; the page layout changed. ${MAINTAINER_ACTION}`,
      );
    }
    return this.fetchText(bundleUrl, transport, 'the x.com main bundle');
  }

  private async fetchText(url: string, transport: XTransport, what: string): Promise<string> {
    let response: Response;
    try {
      response = await transport.fetchImpl(url, {
        headers: webHeaders(transport.credentials),
        redirect: 'follow',
        signal: requestSignal(transport.signal, transport.timeoutMs),
      });
    } catch (error) {
      throw mapThrown(error, transport.signal, transport.timeoutMs, what);
    }
    if (!response.ok) {
      // 401/403 here means the cookie pair died while reading the front end itself, so report the
      // user-fixable cause instead of a generic protocol failure.
      if (response.status === 401 || response.status === 403) {
        throw authFailure(response.status, what);
      }
      throw httpFailure(response.status, what);
    }
    try {
      return await response.text();
    } catch (error) {
      throw mapThrown(error, transport.signal, transport.timeoutMs, what);
    }
  }
}
