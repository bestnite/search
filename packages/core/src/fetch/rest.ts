import { SearchError } from '../transport.js';
import { appUserAgent } from '../ua.js';

/**
 * The REST transport of a provider fetch mode.
 *
 * Some providers expose a documented REST operation instead of an MCP tool. This transport speaks
 * exactly that: one synchronous request — a POST with a JSON body, or the GET-with-query form a
 * provider documents instead — and a JSON document back. It never retries, never follows a redirect
 * and never keeps the provider's own error body, so a response cannot leak into a message. The MCP
 * transport is untouched and stays the default; the caller picks the transport from the access mode's
 * declared transport, never from the endpoint shape.
 *
 * The method is declared per adapter rather than guessed: `postProviderJson` is the POST form and
 * `getProviderJson` the query form. A GET carries no body at all.
 */
export interface ProviderRestRequest {
  endpoint: string;
  /** Auth and content headers. A key here is sent, never logged and never put in a message. */
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  signal: AbortSignal;
  /** Byte bound for the response body; overrunning it is an acquisition limit, not a protocol error. */
  maxResponseBytes: number;
  /** Test/embedding seam for the HTTP exchange; production uses the platform fetch. */
  fetcher?: typeof fetch;
}

/** The documented GET form: every parameter travels in the query string, never in a body. */
export interface ProviderRestGetRequest {
  endpoint: string;
  /** Auth and content headers. A key here is sent, never logged and never put in a message. */
  headers: Record<string, string>;
  /** Query parameters. An absent, `undefined` or empty value is left out; booleans become true/false. */
  query: Record<string, string | number | boolean | undefined>;
  timeoutMs: number;
  signal: AbortSignal;
  maxResponseBytes: number;
  fetcher?: typeof fetch;
}

export interface ProviderRestResponse {
  /** The documented JSON document, already parsed. */
  payload: Record<string, unknown>;
  /** HTTP status the provider API itself answered with. Never the target page's status. */
  apiStatus: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Read at most `limit` bytes, so an unbounded response cannot buffer the process out of memory. */
async function readBoundedText(response: Response, limit: number): Promise<{ text: string; exceeded: boolean }> {
  if (!response.body) return { text: '', exceeded: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => undefined);
      return { text: '', exceeded: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), exceeded: false };
}

/** The failure kind of a provider API status, mirroring the shared transport's classification. */
const failureKindForStatus = (status: number): SearchError['kind'] =>
  status === 401 ? 'authentication' : status === 402 ? 'quota' : status === 429 ? 'rate-limit' : 'http';

/** A message that names the status and the situation, and nothing the provider sent back. */
const failureMessageForStatus = (status: number): string => {
  switch (status) {
    case 401:
      return 'The provider rejected the API key for this fetch.';
    case 402:
      return 'The provider refused this fetch because the account balance or spending budget is exhausted.';
    case 429:
      return 'The provider rate-limited this fetch.';
    default:
      return `The provider API answered HTTP ${status} for this fetch.`;
  }
};

/**
 * One exchange, with the failure mapping both methods share: a request that never got a response is
 * a typed network/timeout failure, an error status is classified by status alone, and the successful
 * answer is bounded, parsed and required to be the documented JSON object.
 */
async function exchange(request: { signal: AbortSignal; timeoutMs: number; maxResponseBytes: number }, send: (signal: AbortSignal) => Promise<Response>): Promise<ProviderRestResponse> {
  const attemptTimeout = AbortSignal.timeout(request.timeoutMs);
  const signal = AbortSignal.any([request.signal, attemptTimeout]);
  let response: Response;
  try {
    response = await send(signal);
  } catch (error) {
    // The caller's own cancellation is reported as such; the attempt deadline is a timeout.
    if (request.signal.aborted) throw new SearchError(attemptTimeout.aborted ? 'timeout' : 'cancelled', 'The provider request was stopped before a response arrived.');
    if (attemptTimeout.aborted) throw new SearchError('timeout', 'The provider did not answer within the route timeout.');
    if (error instanceof SearchError) throw error;
    throw new SearchError('network', 'The provider could not be reached.');
  }

  const apiStatus = response.status;
  if (!response.ok) {
    // The body is never read: a provider error document can carry account details, and the status
    // alone already says what happened.
    await response.body?.cancel().catch(() => undefined);
    throw new SearchError(failureKindForStatus(apiStatus), failureMessageForStatus(apiStatus), apiStatus);
  }

  const { text, exceeded } = await readBoundedText(response, request.maxResponseBytes);
  if (exceeded) throw new SearchError('limit', `The provider response exceeded the ${request.maxResponseBytes}-byte acquisition limit.`, apiStatus);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SearchError('protocol', 'The provider response was not JSON.', apiStatus);
  }
  if (!isRecord(parsed)) throw new SearchError('protocol', 'The provider response was not the documented JSON document.', apiStatus);
  return { payload: parsed, apiStatus };
}

/** POST one JSON request and return the parsed answer, or a typed failure; no secret leaves a message. */
export async function postProviderJson(request: ProviderRestRequest): Promise<ProviderRestResponse> {
  const fetcher = request.fetcher ?? fetch;
  const headers = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': appUserAgent(), ...request.headers };
  const body = JSON.stringify(request.body);
  return exchange(request, signal => fetcher(request.endpoint, { method: 'POST', headers, body, signal, redirect: 'error' }));
}

/**
 * GET one documented query operation and return the parsed answer.
 *
 * A provider that documents its fetch as `GET /path?url=...` is served as that, without pretending
 * it accepts a POST body. The URL is built from the validated endpoint and the adapter's parameters
 * only, so no caller-supplied string is concatenated into it.
 */
export async function getProviderJson(request: ProviderRestGetRequest): Promise<ProviderRestResponse> {
  const fetcher = request.fetcher ?? fetch;
  let url: URL;
  try {
    url = new URL(request.endpoint);
  } catch {
    throw new SearchError('configuration', 'The provider fetch endpoint is not a valid URL.');
  }
  for (const [key, value] of Object.entries(request.query)) {
    if (value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const headers = { accept: 'application/json', 'user-agent': appUserAgent(), ...request.headers };
  const href = url.href;
  return exchange(request, signal => fetcher(href, { method: 'GET', headers, signal, redirect: 'error' }));
}
