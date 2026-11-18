import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { appUserAgent } from '../ua.js';
import type { FetchFormat } from './types.js';
import { parseHtmlDocument } from './html.js';
import { assertTargetPolicy, FetchPolicyError, isPrivateAddress, type AddressResolver } from './safety.js';
import { routeFailure, routeOk, type RouteResult } from './acquisition.js';

/**
 * The HTTP route: manual redirects, bounded streaming reads, explicit charset handling, and a
 * connection bound to the address the policy already validated.
 *
 * The default transport resolves each name inside the socket lookup, refuses a private result there,
 * and connects to the address it just validated. That closes the window a separate preflight would
 * leave open between "this name looks public" and "the socket connected somewhere else". A host may
 * inject another transport, and then its own policy is the one that applies; the route still refuses
 * local names and private literals before any request.
 *
 * There is no additional HTTP client dependency: `undici` is the implementation Node's own `fetch`
 * is built on, used here only because the built-in entry point does not expose a dispatcher hook.
 */

export interface HopRequest {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface HopResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export interface HttpTransport {
  request(request: HopRequest): Promise<HopResponse>;
  close(): Promise<void>;
}

export type HttpTransportFactory = (options: { resolver: AddressResolver; allowPrivateNetworks: boolean }) => HttpTransport;

/**
 * The socket lookup used by the default transport: resolve, apply the address policy to every
 * answer, and return the validated address for the connection that is about to be made.
 */
export function createPinnedLookup(options: {
  resolver: AddressResolver;
  allowPrivateNetworks: boolean;
  onViolation: (reason: string) => void;
}): LookupFunction {
  const lookup = (hostname: string, lookupOptions: unknown, callback: (...args: unknown[]) => void): void => {
    void (async () => {
      try {
        const addresses = await options.resolver(hostname);
        if (!addresses.length) throw new FetchPolicyError('The target host name resolved to no address.');
        if (!options.allowPrivateNetworks) {
          const blocked = addresses.find(address => isPrivateAddress(address));
          if (blocked) {
            const reason = 'The target resolves to a private or reserved address; public-only fetching refuses the connection.';
            options.onViolation(reason);
            throw new FetchPolicyError(reason);
          }
        }
        const chosen = addresses[0]!;
        const family = isIP(chosen);
        // Node asks for one address by default and for every address when a caller requests `all`.
        if ((lookupOptions as { all?: boolean } | undefined)?.all === true) {
          callback(null, addresses.map(address => ({ address, family: isIP(address) })), family);
        } else {
          callback(null, chosen, family);
        }
      } catch (error) {
        callback(error, '', 0);
      }
    })();
  };
  return lookup as unknown as LookupFunction;
}

/** The default transport: undici's fetch on an agent whose lookup pins the validated address. */
export const pinnedTransport: HttpTransportFactory = ({ resolver, allowPrivateNetworks }) => {
  const violations: string[] = [];
  const lookup = createPinnedLookup({ resolver, allowPrivateNetworks, onViolation: reason => violations.push(reason) });
  const agent = new Agent({ connect: { lookup } });
  return {
    async request(request) {
      try {
        const response = await undiciFetch(request.url, {
          method: 'GET',
          redirect: 'manual',
          headers: request.headers,
          signal: request.signal,
          dispatcher: agent,
        } as never);
        return response as unknown as HopResponse;
      } catch (error) {
        // A refusal decided inside the lookup reaches the caller as a policy failure, not a network one.
        if (violations.length) throw new FetchPolicyError(violations[0]!);
        throw error;
      }
    },
    async close() {
      // A fetch that was aborted mid-body can leave a keep-alive socket behind. Close politely, then
      // force the agent down if that did not settle, so one fetch can never keep the process alive.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>(resolve => {
        timer = setTimeout(resolve, 2_000);
        timer.unref?.();
      });
      await Promise.race([agent.close().catch(() => undefined), timeout]);
      if (timer !== undefined) clearTimeout(timer);
      await agent.destroy().catch(() => undefined);
    },
  };
};

/** Adapter for hosts and tests that inject a fetch-compatible transport of their own. */
export const fetchTransport = (fetcher: typeof fetch): HttpTransportFactory => () => ({
  request: async request =>
    (await fetcher(request.url, { method: 'GET', redirect: 'manual', headers: request.headers, signal: request.signal })) as unknown as HopResponse,
  close: async () => undefined,
});

/**
 * The HTTP route: Node's platform transport (or an injected equivalent), manual redirects, bounded
 * streaming reads and explicit charset handling. No cookie jar, no caller-supplied headers and no
 * retry: the route chain is the only fallback mechanism in v1.
 */
export interface HttpRouteRequest {
  url: URL;
  format: FetchFormat;
  routeTimeoutMs: number;
  maxRedirects: number;
  maxBodyBytes: number;
  allowPrivateNetworks: boolean;
  /** Combined caller, deadline and per-route timeout signal. */
  signal: AbortSignal;
  resolver: AddressResolver;
  /** Injected transport; the default pins the connection to a validated address. */
  transportFactory?: HttpTransportFactory;
  /** Convenience for hosts and tests that already have a fetch-compatible function. */
  fetcher?: typeof fetch;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const parseContentType = (header: string | null): { type: string; charset?: string } => {
  if (!header) return { type: '' };
  const [rawType = '', ...parameters] = header.split(';');
  const charsetParameter = parameters.map(part => part.trim()).find(part => /^charset=/i.test(part));
  const charset = charsetParameter ? charsetParameter.slice('charset='.length).replace(/^"|"$/g, '').trim() : undefined;
  return { type: rawType.trim().toLowerCase(), ...(charset ? { charset } : {}) };
};

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

/** Types whose bytes are text in a declared encoding. XML and JSON are text, not HTML documents. */
const TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  'text/css',
  'application/json',
  'application/ld+json',
  'application/xml',
  'text/xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/javascript',
  'text/javascript',
  'application/x-ndjson',
]);

const BINARY_TYPES = new Set([
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/octet-stream',
  'application/vnd.ms-excel',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
]);

const isBinaryType = (type: string): boolean =>
  BINARY_TYPES.has(type) || type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/') || type.startsWith('font/');

const isTextType = (type: string): boolean => type.startsWith('text/') || TEXT_TYPES.has(type);

/** Read at most `maxBodyBytes`, so an unbounded upstream cannot buffer the process out of memory. */
async function readBounded(response: HopResponse, maxBodyBytes: number): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), exceeded: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBodyBytes) {
      await reader.cancel().catch(() => undefined);
      return { bytes: new Uint8Array(0), exceeded: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded: false };
}

const decode = (bytes: Uint8Array, charset: string | undefined): { text: string; note?: string } => {
  if (!charset) return { text: new TextDecoder('utf-8').decode(bytes) };
  try {
    return { text: new TextDecoder(charset).decode(bytes) };
  } catch {
    return { text: new TextDecoder('utf-8').decode(bytes), note: `Unknown charset "${charset}" was decoded as UTF-8.` };
  }
};

const looksLikeHtml = (text: string): boolean => /^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(text.slice(0, 512));

/** A decoded body with a high share of replacement characters is binary, not text to read. */
const looksBinary = (text: string): boolean => {
  if (!text) return false;
  const sample = text.slice(0, 4_096);
  const replacements = (sample.match(/\uFFFD/g) ?? []).length;
  return replacements > 0 && replacements / sample.length > 0.01;
};

export async function fetchOverHttp(request: HttpRouteRequest): Promise<RouteResult> {
  const notes: string[] = [];
  const factory = request.transportFactory ?? (request.fetcher ? fetchTransport(request.fetcher) : pinnedTransport);
  const transport = factory({ resolver: request.resolver, allowPrivateNetworks: request.allowPrivateNetworks });
  let current = request.url;
  let redirects = 0;
  try {
    for (;;) {
      try {
        await assertTargetPolicy(current, request.allowPrivateNetworks, request.resolver);
      } catch (error) {
        if (error instanceof FetchPolicyError) {
          return routeFailure('policy', { kind: 'policy', message: error.message }, { fatal: true, notes });
        }
        throw error;
      }
      const response = await transport.request({
        url: current.href,
        headers: { 'User-Agent': appUserAgent(), Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1' },
        signal: request.signal,
      });
      const ok = response.status >= 200 && response.status < 300;
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) {
          return routeFailure('protocol', { kind: 'protocol', message: `HTTP ${response.status} carried no Location header.` }, { statusCode: response.status, notes });
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return routeFailure('protocol', { kind: 'protocol', message: 'The redirect target is not a valid URL.' }, { statusCode: response.status, notes });
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return routeFailure('policy', { kind: 'policy', message: 'The redirect target is not an HTTP(S) URL.' }, { fatal: true, statusCode: response.status, notes });
        }
        if (next.username || next.password) {
          return routeFailure('policy', { kind: 'policy', message: 'The redirect target carries embedded credentials.' }, { fatal: true, statusCode: response.status, notes });
        }
        redirects += 1;
        if (redirects > request.maxRedirects) {
          return routeFailure('limit', { kind: 'limit', message: `More than ${request.maxRedirects} redirects; the limit stops this fetch.` }, { fatal: true, statusCode: response.status, notes });
        }
        current = next;
        continue;
      }

      const { type, charset } = parseContentType(response.headers.get('content-type'));
      const finalUrl = current.href;
      const { bytes, exceeded } = await readBounded(response, request.maxBodyBytes);
      if (exceeded) {
        return routeFailure('limit', { kind: 'limit', message: `The response body exceeded the ${request.maxBodyBytes}-byte acquisition limit.` }, { fatal: true, statusCode: response.status, finalUrl, notes });
      }
      const decoded = decode(bytes, charset);
      if (decoded.note) notes.push(decoded.note);
      const body = decoded.text;

      if (isBinaryType(type)) {
        return routeFailure('unsupported-content', { kind: 'unsupported-content', message: `The target returned ${type}, which is not a page this project converts.` }, { statusCode: response.status, finalUrl, notes });
      }

      const htmlType = HTML_TYPES.has(type) || (!type && !isBinaryType(type) && looksLikeHtml(body));
      if (htmlType) {
        const parsed = parseHtmlDocument(body, finalUrl);
        const result: RouteResult = {
          outcome: ok ? 'ok' : 'http-error',
          notes,
          finalUrl,
          statusCode: response.status,
          representation: 'response-html',
          html: body,
          cleanHtml: parsed.cleanedHtml,
          text: parsed.text,
          ...(parsed.title ? { title: parsed.title } : {}),
        };
        if (!ok) result.error = { kind: 'http', message: `The target answered HTTP ${response.status}.`, status: response.status };
        return result;
      }

      // A declared type that is neither HTML nor text is refused instead of being decoded and passed
      // off as page content; an untyped body is only read as text when the bytes actually decode.
      if (type && !isTextType(type)) {
        return routeFailure('unsupported-content', { kind: 'unsupported-content', message: `The target returned ${type}, which is not a text or HTML page.` }, { statusCode: response.status, finalUrl, notes });
      }
      if (looksBinary(body)) {
        return routeFailure('unsupported-content', { kind: 'unsupported-content', message: 'The target returned binary content that cannot be read as a page.' }, { statusCode: response.status, finalUrl, notes });
      }

      // Plain text can serve Markdown directly; it is never wrapped into pretend source HTML.
      if (request.format === 'html') {
        return routeFailure('unsupported-content', { kind: 'unsupported-content', message: `The target returned ${type || 'untyped content'}, which cannot be represented as page HTML.` }, { statusCode: response.status, finalUrl, notes });
      }
      const result: RouteResult = {
        outcome: ok ? 'ok' : 'http-error',
        notes,
        finalUrl,
        statusCode: response.status,
        representation: 'response-text',
        text: body,
      };
      if (!ok) result.error = { kind: 'http', message: `The target answered HTTP ${response.status}.`, status: response.status };
      return result;
    }
  } finally {
    await transport.close();
  }
}

export { routeOk };
