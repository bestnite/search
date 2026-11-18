import { callMcp } from '../mcp.js';
import { utf8ByteLength } from './bytes.js';
import type { TransportOptions } from '../transport.js';
import { SearchError } from '../transport.js';
import type { FetchFormat, FetchTransport } from './types.js';
import { routeFailure, routeOk, type RouteResult } from './acquisition.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from './limits.js';
import { delegatedNote } from './notes.js';
import { postProviderJson } from './rest.js';

/** Byte allowance for the JSON-RPC envelope around a page representation. */
export const PROVIDER_PROTOCOL_OVERHEAD_BYTES = 64 * 1024;

/**
 * The provider route: one fetch-capable provider, one request, over the transport its access mode
 * declares.
 *
 * Only the target URL leaves this process. No cookies, no session state and no page HTML are
 * forwarded, and the provider endpoint is trusted operator configuration rather than a caller input.
 * The target document status and the provider API status are kept apart: a provider that answers 200
 * while the target page was 404 is not a successful fetch, and an unknown target status is never
 * invented as 200.
 *
 * The transport is explicit, per access mode: `mcp` is one JSON-RPC tool call, `rest` is the
 * provider's documented HTTP operation. The MCP path never guesses and never becomes generic.
 */
export interface ProviderRouteRequest {
  providerId: string;
  url: string;
  format: FetchFormat;
  /** Transport the saved access mode declares; the adapter table declares one per mode. */
  transport: FetchTransport;
  endpoint: string;
  tool: string;
  options: Record<string, string | number | boolean>;
  routeTimeoutMs: number;
  signal: AbortSignal;
  /** Key for modes that use one; the anonymous endpoints take none and are refused one anyway. */
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

/** An adapter that speaks the provider's MCP tool. */
interface McpAdapterShape {
  arguments: (request: ProviderRouteRequest) => Record<string, unknown>;
  interpret: (result: Record<string, unknown>, request: ProviderRouteRequest, apiStatus: number | undefined, notes: string[]) => RouteResult;
}

/** An adapter that speaks the provider's documented REST operation. */
interface RestAdapterShape {
  /** Headers and JSON body for one target URL. The credential is read from the request, never logged. */
  request: (request: ProviderRouteRequest) => { headers: Record<string, string>; body: Record<string, unknown> };
  interpret: (payload: Record<string, unknown>, request: ProviderRouteRequest, apiStatus: number | undefined, notes: string[]) => RouteResult;
}

/** One provider's adapters by transport. A mode with no adapter is refused, never rerouted. */
interface ProviderAdapters {
  mcp?: McpAdapterShape;
  rest?: RestAdapterShape;
}

const records = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => !!item) : [];

/** A provider tag such as CRAWL_NOT_FOUND is safe to name; the provider's body is not echoed. */
const providerTag = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) && /[A-Za-z]/.test(value) ? value : undefined;

/** A target HTTP status reported by a provider, or undefined when it reported none. */
const targetStatus = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;

/** A JSON document carried as text, for the transports that mirror their payload that way. */
const jsonDocument = (text: string | undefined): Record<string, unknown> | undefined => {
  if (!text) return undefined;
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/**
 * The Parallel Extract document: `{results: [...], errors: [...]}`.
 *
 * Both transports return it — the keyless MCP tool as `structuredContent`, the keyed REST operation
 * as the response body — so the interpretation lives in one place. `results[0].full_content` is
 * native Markdown; `errors[0].http_status_code` is the target's status while the API itself answered
 * 200, and the two are never folded together.
 */
const interpretParallelDocument = (
  document: Record<string, unknown>,
  request: ProviderRouteRequest,
  apiStatus: number | undefined,
  notes: string[],
): RouteResult => {
  const results = records(document.results);
  const errors = records(document.errors);
  if (!results.length) {
    const first = errors[0];
    const status = targetStatus(first?.http_status_code);
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
};

const adapters: Record<string, ProviderAdapters> = {
  // Exa fetches in two documented ways. The keyless MCP tool returns clean Markdown per URL and no
  // target status or title; the keyed REST operation returns Markdown, a title and a per-URL status.
  exa: {
    mcp: {
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
    rest: {
      // POST https://api.exa.ai/contents with x-api-key. `includeHtmlTags` is deliberately not sent:
      // it returns lightweight tags inside the Markdown text, not a page HTML document.
      request: request => {
        const cap = numberOrDefault(request.options.maxCharacters, DEFAULT_MAX_OUTPUT_CHARS);
        return {
          headers: { 'x-api-key': request.credential ?? '' },
          body: { urls: [request.url], text: { maxCharacters: cap } },
        };
      },
      interpret: (payload, request, apiStatus, notes) => {
        const results = records(payload.results);
        const statuses = records(payload.statuses);
        const status = statuses[0];
        if (status?.status === 'error') {
          const error = record(status.error);
          const tag = providerTag(error?.tag);
          const target = targetStatus(error?.httpStatusCode);
          notes.push(tag ? `The provider reported ${tag}.` : 'The provider could not fetch this URL.');
          if (target !== undefined) {
            // The target's status, reported by the provider: the API itself answered 200.
            return routeFailure(
              target >= 400 ? 'http-error' : 'provider-error',
              {
                kind: target >= 400 ? 'http' : 'provider',
                message: `The target answered HTTP ${target} according to the provider.`,
                status: target,
              },
              { statusCode: target, apiStatus, notes },
            );
          }
          return routeFailure('provider-error', { kind: 'provider', message: 'The provider could not fetch this URL; it reported no target status.' }, { apiStatus, notes });
        }
        const page = results[0];
        if (!page) {
          return routeFailure('protocol', { kind: 'protocol', message: 'The provider returned no result for this URL.' }, { apiStatus, notes });
        }
        // `results[0].text` is native Markdown; it is never reconverted.
        const markdown = typeof page.text === 'string' ? page.text : '';
        if (!markdown) {
          return routeFailure('unsupported-content', { kind: 'unsupported-content', message: 'The provider returned no page content for this URL.' }, { apiStatus, notes });
        }
        const title = typeof page.title === 'string' && page.title.trim() !== '' ? page.title.trim() : undefined;
        const finalUrl = typeof page.url === 'string' && page.url !== '' ? page.url : request.url;
        return routeOk({ representation: 'provider-markdown', markdown, finalUrl, apiStatus, ...(title ? { title } : {}), notes });
      },
    },
  },
  // Parallel fetches over its MCP tool keylessly and over its documented REST Extract operation with
  // a key. Both return the same document, so only the exchange differs.
  parallel: {
    mcp: {
      arguments: request => {
        const fullContent = request.options.full_content !== false;
        return { urls: [request.url], full_content: fullContent };
      },
      interpret: (result, request, apiStatus, notes) => {
        const document = record(result.structuredContent) ?? jsonDocument(contentText(result));
        if (!document) {
          return routeFailure('protocol', { kind: 'protocol', message: 'The provider response was not the documented JSON document.' }, { apiStatus, notes });
        }
        return interpretParallelDocument(document, request, apiStatus, notes);
      },
    },
    rest: {
      // POST https://api.parallel.ai/v1/extract with x-api-key. On the GA endpoint `full_content`
      // lives inside `advanced_settings`; the v1beta top-level form answers 422.
      request: request => {
        const fullContent = request.options.full_content !== false;
        return {
          headers: { 'x-api-key': request.credential ?? '' },
          body: { urls: [request.url], advanced_settings: { full_content: fullContent } },
        };
      },
      interpret: (payload, request, apiStatus, notes) => interpretParallelDocument(payload, request, apiStatus, notes),
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
    // The transport authors these messages itself and they never carry the provider's body, so the
    // specific one ("balance exhausted" vs "rate-limited") is kept instead of a generic status line.
    return routeFailure(
      'provider-error',
      { kind: 'provider', message: origin.message || `The provider API answered HTTP ${status ?? 'an error'} for this fetch.`, ...(status === undefined ? {} : { status }) },
      { apiStatus: status, notes },
    );
  }
  if (origin.kind === 'network') {
    return routeFailure('network', { kind: 'network', message: 'The provider could not be reached.' }, { apiStatus: status, notes });
  }
  return routeFailure('protocol', { kind: 'protocol', message: 'The provider answered in an unexpected way.' }, { apiStatus: status, notes });
};

export const fetchFromProvider: ProviderFetcher = async (request, call) => {
  const providerAdapters = adapters[request.providerId];
  // The provider resolves the target on its own side, so the local public-only policy cannot prove
  // its destination. Enabling the route is the decision; every result still says what was not proven.
  const notes: string[] = [delegatedNote('provider')];
  if (!providerAdapters) {
    return routeFailure('unsupported-format', { kind: 'protocol', message: `No fetch adapter exists for ${request.providerId}.` }, { notes });
  }
  if (request.transport === 'rest') {
    const rest = providerAdapters.rest;
    if (!rest) {
      return routeFailure('protocol', { kind: 'protocol', message: `"${request.providerId}" has no REST fetch operation.` }, { notes });
    }
    // A keyed mode is refused before the request is built: an unauthenticated call would spend a wire
    // round-trip to be told what the configuration already says. The outcome is a normal
    // authentication failure, never a fatal error, so a caller's fallback rules still apply.
    if (!request.credential) {
      notes.push('The provider credential is missing, so no request was sent.');
      return routeFailure(
        'authentication',
        { kind: 'authentication', message: `The ${request.providerId} fetch mode needs a stored API key, and none is configured.` },
        { notes },
      );
    }
    const { headers, body } = rest.request(request);
    return postProviderJson({
      endpoint: request.endpoint,
      headers,
      body,
      timeoutMs: request.routeTimeoutMs,
      signal: request.signal,
      // A REST answer wraps the representation in a JSON document, so it gets the same explicit
      // envelope allowance the MCP wire bound uses.
      maxResponseBytes: request.maxChars + PROVIDER_PROTOCOL_OVERHEAD_BYTES,
      ...(request.fetcher ? { fetcher: request.fetcher } : {}),
    }).then(
      ({ payload, apiStatus }) => boundResult(rest.interpret(payload, request, apiStatus, notes), request),
      (error: unknown) => {
        if (error instanceof SearchError) return fromSearchError(error, undefined, notes);
        return routeFailure('network', { kind: 'network', message: 'The provider call failed before a response arrived.' }, { notes });
      },
    );
  }
  const mcp = providerAdapters.mcp;
  if (!mcp) {
    return routeFailure('protocol', { kind: 'protocol', message: `"${request.providerId}" has no MCP fetch tool.` }, { notes });
  }
  const args = mcp.arguments(request);
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
    ({ result, apiStatus }) => boundResult(mcp.interpret(result, request, apiStatus, notes), request),
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

/** Build the MCP tool arguments for one provider definition; a REST mode has no tool arguments. */
export function providerArguments(providerId: string, request: ProviderRouteRequest): Record<string, unknown> | undefined {
  return adapters[providerId]?.mcp?.arguments(request);
}
