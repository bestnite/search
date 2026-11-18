import { callMcp } from '../mcp.js';
import { utf8ByteLength } from './bytes.js';
import type { TransportOptions } from '../transport.js';
import { SearchError } from '../transport.js';
import type { FetchFormat } from './types.js';
import { routeFailure, routeOk, type RouteResult } from './acquisition.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from './limits.js';

/** Byte allowance for the JSON-RPC envelope around a page representation. */
export const PROVIDER_PROTOCOL_OVERHEAD_BYTES = 64 * 1024;

/**
 * The provider route: one fetch-capable provider, one MCP tool, one request.
 *
 * Only the target URL leaves this process. No cookies, no session state and no page HTML are
 * forwarded, and the provider endpoint is trusted operator configuration rather than a caller input.
 * The target document status and the provider API status are kept apart: a provider that answers 200
 * while the target page was 404 is not a successful fetch, and an unknown target status is never
 * invented as 200.
 */
export interface ProviderRouteRequest {
  providerId: string;
  url: string;
  format: FetchFormat;
  endpoint: string;
  tool: string;
  options: Record<string, string | number | boolean>;
  routeTimeoutMs: number;
  signal: AbortSignal;
  /** Key for providers whose access mode uses one; the anonymous endpoints take none. */
  credential?: string;
  /** Acquisition bound in UTF-8 bytes for the returned representation; exceeding it is fatal. */
  maxChars: number;
  /** Test/embedding seam for the HTTP exchange; production leaves it out. */
  fetcher?: typeof fetch;
}

export interface ProviderCallRequest {
  endpoint: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  signal: AbortSignal;
  credential?: string;
  /** Configured acquisition bound; the transport refuses a larger wire body as a limit. */
  maxChars?: number;
  fetcher?: typeof fetch;
}

export interface ProviderCallResult {
  result: Record<string, unknown>;
  /** HTTP status of the last provider API response, when the transport saw one. */
  apiStatus?: number;
}

export type ProviderCall = (request: ProviderCallRequest) => Promise<ProviderCallResult>;
export type ProviderFetcher = (request: ProviderRouteRequest, call: ProviderCall) => Promise<RouteResult>;

const noRetry: TransportOptions['retry'] = { enabled: false, statuses: [], maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0, networkErrors: false, timeouts: false };

/** A provider transport failure that still remembers the API status it was observed with. */
export class ProviderFailure extends SearchError {
  constructor(public readonly origin: SearchError, public readonly apiStatus?: number) {
    super(origin.kind, origin.message, origin.status, origin.attempts);
    this.name = 'ProviderFailure';
  }
}

/** Default transport: the same official MCP client and failure mapping the search path uses. */
export const callProviderTool: ProviderCall = async request => {
  let apiStatus: number | undefined;
  const transport: TransportOptions = {
    retry: noRetry,
    signal: request.signal,
    attemptTimeoutMs: request.timeoutMs,
    beforeAttempt: () => undefined,
    onAttempt: () => undefined,
    // The wire carries a JSON-RPC envelope around the representation, so the transport bound is the
    // configured acquisition bound plus an explicit, documented overhead. Exceeding it cancels the
    // read immediately and is reported as a limit, never as a protocol failure.
    ...(request.maxChars === undefined
      ? {}
      : {
          maxResponseBytes: request.maxChars + PROVIDER_PROTOCOL_OVERHEAD_BYTES,
          oversizeKind: 'limit' as const,
          oversizeMessage: 'The provider response exceeded the configured acquisition limit plus protocol overhead.',
        }),
  };
  try {
    const result = await callMcp(
      request.endpoint,
      request.tool,
      request.args,
      transport,
      {
        onStatus: status => { apiStatus = status; },
        // The adapter must see a structured tool error: that response is what names a provider code.
        returnErrorResult: true,
        ...(request.fetcher ? { fetcher: request.fetcher } : {}),
      },
    );
    return { result, ...(apiStatus === undefined ? {} : { apiStatus }) };
  } catch (error) {
    if (error instanceof SearchError) {
      // The shared transport keeps its 4 MiB wire guard; for a page fetch that guard is an
      // acquisition limit, so it is reclassified instead of surfacing as a protocol failure.
      const limited = error.kind === 'protocol' && /exceeds .*limit/i.test(error.message)
        ? new SearchError('limit', 'The provider response exceeded the transport response limit.', error.status, error.attempts)
        : error;
      throw new ProviderFailure(limited, apiStatus ?? error.status);
    }
    throw error;
  }
};

const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

const contentText = (result: Record<string, unknown>): string | undefined => {
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const item = record(block);
    if (item && item.type === 'text' && typeof item.text === 'string') return item.text;
  }
  return undefined;
};

const numberOrDefault = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback);

/** A provider code such as CRAWL_NOT_FOUND is safe to name; the provider's body is not echoed. */
const providerCode = (text: string | undefined): string | undefined => {
  if (!text) return undefined;
  const match = /\b([A-Z][A-Z0-9_]{3,40})\b/.exec(text.slice(0, 500));
  return match?.[1];
};

// --- adapters ---------------------------------------------------------------------------------

interface AdapterShape {
  arguments: (request: ProviderRouteRequest) => Record<string, unknown>;
  interpret: (result: Record<string, unknown>, request: ProviderRouteRequest, apiStatus: number | undefined, notes: string[]) => RouteResult;
}

const adapters: Record<string, AdapterShape> = {
  // Exa's keyless MCP: web_fetch_exa returns clean Markdown per URL and no target status or title.
  exa: {
    arguments: request => {
      const cap = numberOrDefault(request.options.maxCharacters, DEFAULT_MAX_OUTPUT_CHARS);
      return { urls: [request.url], maxCharacters: cap };
    },
    interpret: (result, request, apiStatus, notes) => {
      const body = contentText(result);
      if (result.isError === true) {
        const code = providerCode(body);
        notes.push(code ? `The provider reported ${code}.` : 'The provider could not fetch this URL.');
        return routeFailure(
          'provider-error',
          { kind: 'provider', message: 'The provider could not fetch this URL; it reported no target status.' },
          { apiStatus, notes },
        );
      }
      if (!body) {
        return routeFailure('protocol', { kind: 'protocol', message: 'The provider returned no text for this URL.' }, { apiStatus, notes });
      }
      return routeOk({ representation: 'provider-markdown', markdown: body, finalUrl: request.url, apiStatus, notes });
    },
  },
  // Parallel's keyless MCP: web_fetch returns Markdown per URL, the page title, and target status on failure.
  parallel: {
    arguments: request => {
      const fullContent = request.options.full_content !== false;
      return { urls: [request.url], full_content: fullContent };
    },
    interpret: (result, request, apiStatus, notes) => {
      const structured = record(result.structuredContent) ?? (() => {
        const text = contentText(result);
        if (!text) return undefined;
        try {
          return record(JSON.parse(text));
        } catch {
          return undefined;
        }
      })();
      if (!structured) {
        return routeFailure('protocol', { kind: 'protocol', message: 'The provider response was not the documented JSON document.' }, { apiStatus, notes });
      }
      const results = Array.isArray(structured.results) ? structured.results.map(record).filter((item): item is Record<string, unknown> => !!item) : [];
      const errors = Array.isArray(structured.errors) ? structured.errors.map(record).filter((item): item is Record<string, unknown> => !!item) : [];
      if (!results.length) {
        const first = errors[0];
        const status = typeof first?.http_status_code === 'number' ? first.http_status_code : undefined;
        const errorType = typeof first?.error_type === 'string' ? first.error_type.slice(0, 40) : undefined;
        if (status !== undefined) {
          return routeFailure(
            status === 404 || status === 410 ? 'http-error' : 'provider-error',
            { kind: status >= 400 ? 'http' : 'provider', message: `The target answered HTTP ${status} according to the provider.`, status },
            { statusCode: status, apiStatus, notes },
          );
        }
        notes.push(errorType ? `The provider reported ${errorType}.` : 'The provider returned no page and no target status.');
        return routeFailure('provider-error', { kind: 'provider', message: 'The provider could not fetch this URL; it reported no target status.' }, { apiStatus, notes });
      }
      const page = results[0]!;
      const markdown = typeof page.full_content === 'string' && page.full_content !== ''
        ? page.full_content
        : (Array.isArray(page.excerpts) ? page.excerpts.filter((item): item is string => typeof item === 'string').join('\n\n') : '');
      if (!markdown) {
        return routeFailure('unsupported-content', { kind: 'unsupported-content', message: 'The provider returned no page content for this URL.' }, { apiStatus, notes });
      }
      const title = typeof page.title === 'string' && page.title.trim() !== '' ? page.title.trim() : undefined;
      const finalUrl = typeof page.url === 'string' && page.url !== '' ? page.url : request.url;
      return routeOk({ representation: 'provider-markdown', markdown, finalUrl, apiStatus, ...(title ? { title } : {}), notes });
    },
  },
};

/** Failures raised by the shared MCP client keep their kind; they are sanitized before they surface. */
const fromSearchError = (error: SearchError, apiStatus: number | undefined, notes: string[]): RouteResult => {
  const origin = error instanceof ProviderFailure ? error.origin : error;
  const status = apiStatus ?? (error instanceof ProviderFailure ? error.apiStatus : undefined) ?? origin.status;
  if (origin.kind === 'protocol' && /exceeds .*limit/i.test(origin.message)) {
    return routeFailure('limit', { kind: 'limit', message: 'The provider response exceeded the transport response limit.' }, { fatal: true, ...(status === undefined ? {} : { apiStatus: status }), notes });
  }
  if (origin.kind === 'limit') {
    return routeFailure('limit', { kind: 'limit', message: 'The provider response exceeded the configured acquisition limit.' }, { fatal: true, ...(status === undefined ? {} : { apiStatus: status }), notes });
  }
  if (origin.kind === 'cancelled' || origin.kind === 'timeout') {
    return routeFailure(origin.kind === 'timeout' ? 'timeout' : 'cancelled', { kind: origin.kind === 'timeout' ? 'timeout' : 'network', message: origin.message }, { fatal: origin.kind === 'cancelled', ...(status === undefined ? {} : { apiStatus: status }), notes });
  }
  if (origin.kind === 'authentication') {
    return routeFailure('authentication', { kind: 'authentication', message: 'The provider rejected the credential for this operation.', ...(status === undefined ? {} : { status }) }, { apiStatus: status, notes });
  }
  if (origin.kind === 'http' || origin.kind === 'rate-limit' || origin.kind === 'quota') {
    return routeFailure('provider-error', { kind: 'provider', message: `The provider API answered HTTP ${status ?? 'an error'} for this fetch.`, ...(status === undefined ? {} : { status }) }, { apiStatus: status, notes });
  }
  if (origin.kind === 'network') {
    return routeFailure('network', { kind: 'network', message: 'The provider could not be reached.' }, { apiStatus: status, notes });
  }
  return routeFailure('protocol', { kind: 'protocol', message: 'The provider answered in an unexpected way.' }, { apiStatus: status, notes });
};

export const fetchFromProvider: ProviderFetcher = async (request, call) => {
  const adapter = adapters[request.providerId];
  const notes: string[] = [];
  if (!adapter) {
    return routeFailure('unsupported-format', { kind: 'protocol', message: `No fetch adapter exists for ${request.providerId}.` }, { notes });
  }
  const args = adapter.arguments(request);
  return call({
    endpoint: request.endpoint,
    tool: request.tool,
    args,
    timeoutMs: request.routeTimeoutMs,
    signal: request.signal,
    ...(request.credential ? { credential: request.credential } : {}),
    maxChars: request.maxChars,
    ...(request.fetcher ? { fetcher: request.fetcher } : {}),
  }).then(
    ({ result, apiStatus }) => boundResult(adapter.interpret(result, request, apiStatus, notes), request),
    (error: unknown) => {
      if (error instanceof SearchError) return fromSearchError(error, undefined, notes);
      return routeFailure('network', { kind: 'network', message: 'The provider call failed before a response arrived.' }, { notes });
    },
  );
};

/** A representation over the configured bound is an acquisition limit, never a partial page. */
function boundResult(result: RouteResult, request: ProviderRouteRequest): RouteResult {
  const sizes = [result.markdown, result.html, result.cleanHtml, result.text]
    .filter((value): value is string => typeof value === 'string')
    .map(value => utf8ByteLength(value));
  if (!sizes.length || Math.max(...sizes) <= request.maxChars) return result;
  return routeFailure(
    'limit',
    { kind: 'limit', message: `The provider returned more than the ${request.maxChars}-byte acquisition limit.` },
    { fatal: true, ...(result.apiStatus === undefined ? {} : { apiStatus: result.apiStatus }), notes: result.notes },
  );
}

/** Build the adapter request for one provider definition; used by the settings test path too. */
export function providerArguments(providerId: string, request: ProviderRouteRequest): Record<string, unknown> | undefined {
  return adapters[providerId]?.arguments(request);
}
