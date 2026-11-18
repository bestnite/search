import { callMcp } from '../mcp.js';
import { utf8ByteLength } from './bytes.js';
import type { TransportOptions } from '../transport.js';
import { SearchError } from '../transport.js';
import type { AccessMode } from '../types.js';
import type { FetchFormat, FetchTransport } from './types.js';
import { routeFailure, routeOk, type RouteResult } from './acquisition.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from './limits.js';
import { delegatedNote } from './notes.js';
import { getProviderJson, postProviderJson } from './rest.js';

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
  /**
   * The saved access mode. It decides whether a credential is required at all: an `anonymous` mode
   * sends none and is never refused for lacking one. Absent means the conservative reading, a mode
   * that needs the key.
   */
  mode?: AccessMode;
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
  /** The documented HTTP method; POST with a JSON body unless a provider documents a GET query. */
  method?: 'post' | 'get';
  /**
   * Headers and the documented parameters for one target URL: a JSON body for `post`, query
   * parameters for `get`. The credential is read from the request, never logged.
   */
  request: (request: ProviderRouteRequest) => {
    headers: Record<string, string>;
    body?: Record<string, unknown>;
    query?: Record<string, string | number | boolean | undefined>;
  };
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

/**
 * A stable provider error code: an alphanumeric tag such as `robots_disallowed`, or a short numeric
 * code such as `10409`. Anything longer or odd-shaped is dropped rather than echoed.
 */
const errorCode = (tag: unknown, numeric?: unknown): string | undefined =>
  providerTag(tag)
  ?? (typeof numeric === 'number' && Number.isInteger(numeric) ? String(numeric) : undefined)
  ?? (typeof tag === 'string' && /^\d{1,8}$/.test(tag) ? tag : undefined);

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
      // The same rule both providers use: a target status the provider reported is the target's HTTP
      // failure when it is 400 or above, and a provider-side failure only when it is not.
      return routeFailure(
        status >= 400 ? 'http-error' : 'provider-error',
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

/** A string field of a provider document, or the empty string when it is absent or not a string. */
const stringField = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A trimmed, non-empty title. An empty title is unavailable, never an empty string. */
const titleValue = (value: unknown): string | undefined => {
  const title = stringField(value).trim();
  return title === '' ? undefined : title;
};

/** The final URL a provider reported, or the requested one when it reported none. */
const finalUrlValue = (value: unknown, request: ProviderRouteRequest): string => {
  const url = stringField(value);
  return url === '' ? request.url : url;
};

/** A bearer header for the modes whose contract documents one. */
const bearerHeader = (request: ProviderRouteRequest): Record<string, string> => ({ authorization: `Bearer ${request.credential ?? ''}` });

/** The documented JSON body of one target URL, for providers whose request carries only that. */
const urlBody = (request: ProviderRouteRequest): Record<string, unknown> => ({ url: request.url });

/** A page the provider returned with no usable representation of the requested kind. */
const noContent = (notes: string[], apiStatus: number | undefined, message: string): RouteResult =>
  routeFailure('unsupported-content', { kind: 'unsupported-content', message }, { apiStatus, notes });

/** A target status the provider reported is the target's failure when it is 400 or above. */
const reportedTargetFailure = (
  target: number,
  apiStatus: number | undefined,
  notes: string[],
): RouteResult =>
  routeFailure(
    target >= 400 ? 'http-error' : 'provider-error',
    {
      kind: target >= 400 ? 'http' : 'provider',
      message: target >= 400
        ? `The target answered HTTP ${target} according to the provider.`
        : `The provider could not fetch this URL; the target answered ${target} according to the provider.`,
      ...(target >= 400 ? { status: target } : {}),
    },
    // The target status itself is always the one the provider reported, never a guess.
    { statusCode: target, apiStatus, notes },
  );

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
  // DeepSeek documents one REST Fetch operation beside its Search operation: the request is the URL
  // alone, the answer is `{title, content}` with Markdown content, and the API reports no target
  // status. Its 404 means "Fetch could not retrieve usable page content", which is the API's own
  // answer and is never written to the attempt as the target's status.
  deepseek: {
    rest: {
      request: request => ({ headers: bearerHeader(request), body: urlBody(request) }),
      interpret: (payload, request, apiStatus, notes) => {
        const markdown = stringField(payload.content);
        if (!markdown) return noContent(notes, apiStatus, 'The provider returned no page content for this URL.');
        const title = titleValue(payload.title);
        return routeOk({ representation: 'provider-markdown', markdown, finalUrl: request.url, apiStatus, ...(title ? { title } : {}), notes });
      },
    },
  },
  // Serpex documents one Crawl operation: URLs plus a format, and `results[].status_code` is the
  // target's status while the API itself answered 200. `format: html` returns the full rendered HTML
  // of the page, so this adapter can serve both formats without wrapping one as the other.
  serpex: {
    rest: {
      request: request => ({
        headers: bearerHeader(request),
        body: { urls: [request.url], format: request.format === 'html' ? 'html' : 'markdown' },
      }),
      interpret: (payload, request, apiStatus, notes) => {
        const page = records(payload.results)[0];
        if (!page) {
          notes.push('The provider returned no result for this URL.');
          return routeFailure('protocol', { kind: 'protocol', message: 'The provider returned no result for this URL.' }, { apiStatus, notes });
        }
        const target = targetStatus(page.status_code);
        if (page.success !== true) {
          const tag = providerTag(page.error_type);
          notes.push(tag ? `The provider reported ${tag}.` : 'The provider could not fetch this URL.');
          if (target !== undefined) return reportedTargetFailure(target, apiStatus, notes);
          return routeFailure('provider-error', { kind: 'provider', message: 'The provider could not fetch this URL; it reported no target status.' }, { apiStatus, notes });
        }
        const content = request.format === 'html' ? stringField(page.html) : stringField(page.markdown);
        if (!content) return noContent(notes, apiStatus, `The provider returned no ${request.format === 'html' ? 'page HTML' : 'page content'} for this URL.`);
        return routeOk({
          representation: request.format === 'html' ? 'provider-html' : 'provider-markdown',
          ...(request.format === 'html' ? { html: content } : { markdown: content }),
          finalUrl: finalUrlValue(page.url, request),
          ...(target === undefined ? {} : { statusCode: target }),
          apiStatus,
          notes,
        });
      },
    },
  },
  // Linkup's Fetch operation always returns Markdown; page HTML only comes back as `rawContent` when
  // the request asks for it, and `contentType` says what that content is. The adapter asks for it on
  // an HTML request alone, and refuses to label a non-HTML body as the page's HTML.
  linkup: {
    rest: {
      request: request => ({
        headers: bearerHeader(request),
        body: {
          url: request.url,
          mode: request.options.mode === 'pro' ? 'pro' : 'standard',
          renderJs: request.options.renderJs === true,
          ...(request.format === 'html' ? { includeRawContent: true } : {}),
        },
      }),
      interpret: (payload, request, apiStatus, notes) => {
        const markdown = stringField(payload.markdown);
        if (request.format === 'html') {
          const raw = stringField(payload.rawContent);
          const contentType = stringField(payload.contentType).toLowerCase();
          if (!raw || !contentType.includes('html')) {
            notes.push('The provider returned no page HTML for this URL.');
            return noContent(notes, apiStatus, 'The provider returned no page HTML for this URL.');
          }
          return routeOk({ representation: 'provider-html', html: raw, finalUrl: request.url, apiStatus, notes });
        }
        if (!markdown) return noContent(notes, apiStatus, 'The provider returned no page content for this URL.');
        return routeOk({ representation: 'provider-markdown', markdown, finalUrl: request.url, apiStatus, notes });
      },
    },
  },
  // Tavily extracts with a key, and its documented keyless header selects the free anonymous path on
  // the same endpoint. The two modes differ only in that header: the keyed mode sends the bearer key
  // and no keyless marker, and the anonymous mode sends the marker and never a credential.
  tavily: {
    rest: {
      request: request => ({
        // The keyed mode sends the bearer key and no keyless marker; the anonymous mode sends the marker
        // and never a credential. The endpoint is the same documented operation in both cases.
        headers: (request.credential
          ? { authorization: `Bearer ${request.credential}` }
          : { 'x-tavily-access-mode': 'keyless' }) as Record<string, string>,
        body: {
          urls: [request.url],
          format: request.options.format === 'text' ? 'text' : 'markdown',
          extract_depth: request.options.extract_depth === 'advanced' ? 'advanced' : 'basic',
        },
      }),
      interpret: (payload, request, apiStatus, notes) => {
        const page = records(payload.results)[0];
        if (!page) {
          if (records(payload.failed_results).length) notes.push('The provider reported that it could not process this URL.');
          else notes.push('The provider returned no result for this URL.');
          return routeFailure('provider-error', { kind: 'provider', message: 'The provider could not fetch this URL; it reports no target status.' }, { apiStatus, notes });
        }
        const content = stringField(page.raw_content);
        if (!content) return noContent(notes, apiStatus, 'The provider returned no page content for this URL.');
        const title = titleValue(page.title);
        // `format: text` is plain text, not Markdown; it is labelled what it is instead of being
        // relabelled as native Markdown.
        const asText = request.options.format === 'text';
        return routeOk({
          representation: asText ? 'response-text' : 'provider-markdown',
          ...(asText ? { text: content } : { markdown: content }),
          finalUrl: finalUrlValue(page.url, request),
          apiStatus,
          ...(title ? { title } : {}),
          notes,
        });
      },
    },
  },
  // You.com's Extract operation asks for exactly the formats the caller wants, and returns them under
  // `contents.full_page`. The response carries a title and no target status.
  you: {
    rest: {
      request: request => ({
        headers: { 'x-api-key': request.credential ?? '' },
        body: { url: request.url, full_page: { extraction_formats: [request.format === 'html' ? 'html' : 'markdown'] } },
      }),
      interpret: (payload, request, apiStatus, notes) => {
        const fullPage = record(record(payload.contents)?.full_page);
        const title = titleValue(payload.title);
        const finalUrl = finalUrlValue(payload.url, request);
        if (request.format === 'html') {
          const html = stringField(fullPage?.html);
          if (!html) return noContent(notes, apiStatus, 'The provider returned no page HTML for this URL.');
          return routeOk({ representation: 'provider-html', html, finalUrl, apiStatus, ...(title ? { title } : {}), notes });
        }
        const markdown = stringField(fullPage?.markdown);
        if (!markdown) return noContent(notes, apiStatus, 'The provider returned no page content for this URL.');
        return routeOk({ representation: 'provider-markdown', markdown, finalUrl, apiStatus, ...(title ? { title } : {}), notes });
      },
    },
  },
  // Keenable's Fetch operation is documented as GET with query parameters, and its public path takes
  // the same parameters without a key but with the application title header. It returns Markdown, a
  // title, a truncation flag and no target status.
  keenable: {
    rest: {
      method: 'get',
      request: request => ({
        headers: (request.mode === 'anonymous'
          ? { 'X-Keenable-Title': String(request.options.clientTitle || 'dsh-search') }
          : { 'X-API-Key': request.credential ?? '' }) as Record<string, string>,
        query: {
          url: request.url,
          max_chars: numberOrDefault(request.options.max_chars, DEFAULT_MAX_OUTPUT_CHARS),
          live: request.options.live === true,
        },
      }),
      interpret: (payload, request, apiStatus, notes) => {
        const markdown = stringField(payload.content);
        if (!markdown) return noContent(notes, apiStatus, 'The provider returned no page content for this URL.');
        if (payload.truncated === true) notes.push('The provider truncated the page at its own max_chars bound.');
        const title = titleValue(payload.title);
        return routeOk({ representation: 'provider-markdown', markdown, finalUrl: finalUrlValue(payload.url, request), apiStatus, ...(title ? { title } : {}), notes });
      },
    },
  },
  // AnySearch extracts cleaned text with no format choice, so it is labelled text and never presented
  // as page HTML or as native Markdown. The response has a title and no target status.
  anysearch: {
    rest: {
      request: request => ({ headers: request.credential ? bearerHeader(request) : {}, body: urlBody(request) }),
      interpret: (payload, request, apiStatus, notes) => {
        if (payload.code !== undefined && payload.code !== 0 && payload.code !== 200) {
          notes.push('The provider reported an application-level error; check the account console.');
          return routeFailure('provider-error', { kind: 'provider', message: 'The provider could not fetch this URL; it reported no target status.' }, { apiStatus, notes });
        }
        const data = record(payload.data);
        const content = stringField(data?.content);
        if (!content) return noContent(notes, apiStatus, 'The provider returned no page content for this URL.');
        const title = titleValue(data?.title);
        return routeOk({ representation: 'response-text', text: content, finalUrl: finalUrlValue(data?.url, request), apiStatus, ...(title ? { title } : {}), notes });
      },
    },
  },
  // Doubao's Fetch operation returns plain text, a title and the target's own status in
  // `Result.Data.StatusCode`, while `ResponseMetadata.Error` is the API's own failure. Both are read
  // separately: an API error is never a target status, and an unreadable target status is never
  // invented.
  doubao: {
    rest: {
      request: request => ({ headers: bearerHeader(request), body: { Url: request.url } }),
      interpret: (payload, request, apiStatus, notes) => {
        const apiError = record(record(payload.ResponseMetadata)?.Error);
        if (apiError) {
          const code = errorCode(apiError.Code, apiError.CodeN);
          notes.push(code ? `The provider reported ${code}.` : 'The provider reported an error for this fetch.');
          return routeFailure('provider-error', { kind: 'provider', message: 'The provider could not fetch this URL; it reported no target status.' }, { apiStatus, notes });
        }
        const data = record(record(payload.Result)?.Data);
        if (!data) {
          return routeFailure('protocol', { kind: 'protocol', message: 'The provider returned no result for this URL.' }, { apiStatus, notes });
        }
        const target = targetStatus(data.StatusCode);
        const content = stringField(data.ContentText);
        if (!content) {
          if (target !== undefined && target >= 400) return reportedTargetFailure(target, apiStatus, notes);
          notes.push('The provider returned no page text for this URL.');
          return routeFailure(
            'unsupported-content',
            { kind: 'unsupported-content', message: 'The provider returned no page text for this URL.' },
            { ...(target === undefined ? {} : { statusCode: target }), apiStatus, notes },
          );
        }
        const title = titleValue(data.Title);
        return routeOk({
          representation: 'response-text',
          text: content,
          finalUrl: finalUrlValue(data.RedirectedUrl || data.Url, request),
          ...(target === undefined ? {} : { statusCode: target }),
          apiStatus,
          ...(title ? { title } : {}),
          notes,
        });
      },
    },
  },
  // open-websearch is a self-hosted daemon: its fetch-web operation answers with the daemon's own
  // envelope around the page payload, and the payload has no target status at all.
  'open-websearch': {
    rest: {
      request: request => ({
        headers: {},
        body: {
          url: request.url,
          maxChars: numberOrDefault(request.options.maxChars, DEFAULT_MAX_OUTPUT_CHARS),
          renderMode: request.options.renderMode === 'request' || request.options.renderMode === 'browser' ? request.options.renderMode : 'auto',
        },
      }),
      interpret: (payload, request, apiStatus, notes) => {
        if (payload.status !== 'ok') {
          const code = providerTag(record(payload.error)?.code);
          notes.push(code ? `The self-hosted daemon reported ${code}.` : 'The self-hosted daemon reported an error.');
          return routeFailure('provider-error', { kind: 'provider', message: 'The self-hosted daemon could not fetch this URL; it reports no target status.' }, { apiStatus, notes });
        }
        const data = record(payload.data);
        const content = stringField(data?.content);
        if (!content) return noContent(notes, apiStatus, 'The self-hosted daemon returned no page content for this URL.');
        if (data?.truncated === true) notes.push('The self-hosted daemon truncated the page at its own maxChars bound.');
        const title = titleValue(data?.title);
        return routeOk({
          representation: 'response-text',
          text: content,
          finalUrl: finalUrlValue(data?.finalUrl ?? data?.url, request),
          apiStatus,
          ...(title ? { title } : {}),
          notes,
        });
      },
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
    // authentication failure, never a fatal error, so a caller's fallback rules still apply. An
    // anonymous mode is the opposite case: it sends no credential and is never refused for that.
    const anonymous = request.mode === 'anonymous';
    if (!anonymous && !request.credential) {
      notes.push('The provider credential is missing, so no request was sent.');
      return routeFailure(
        'authentication',
        { kind: 'authentication', message: `The ${request.providerId} fetch mode needs a stored API key, and none is configured.` },
        { notes },
      );
    }
    const { headers, body, query } = rest.request(request);
    // A REST answer wraps the representation in a JSON document, so it gets the same explicit
    // envelope allowance the MCP wire bound uses.
    const maxResponseBytes = request.maxChars + PROVIDER_PROTOCOL_OVERHEAD_BYTES;
    const exchange = rest.method === 'get'
      ? getProviderJson({
          endpoint: request.endpoint,
          headers,
          query: query ?? {},
          timeoutMs: request.routeTimeoutMs,
          signal: request.signal,
          maxResponseBytes,
          ...(request.fetcher ? { fetcher: request.fetcher } : {}),
        })
      : postProviderJson({
          endpoint: request.endpoint,
          headers,
          body: body ?? {},
          timeoutMs: request.routeTimeoutMs,
          signal: request.signal,
          maxResponseBytes,
          ...(request.fetcher ? { fetcher: request.fetcher } : {}),
        });
    return exchange.then(
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
