import { createHash, createHmac } from 'node:crypto';
import type { AdapterInput, AdapterResult, FailureKind, Source } from './types.js';
import { requestJson, SearchError, type TransportOptions } from './transport.js';

type Row = Record<string, unknown>;
function object(value: unknown): Row | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
}
function credentials(raw: string | undefined): { secretId: string; secretKey: string } {
  try {
    const value = object(JSON.parse(raw ?? ''));
    if (value && typeof value.secretId === 'string' && /^[A-Za-z0-9_-]+$/.test(value.secretId)
      && typeof value.secretKey === 'string' && value.secretKey.trim() && !/[\r\n]/.test(value.secretKey)) {
      return { secretId: value.secretId, secretKey: value.secretKey };
    }
  } catch { /* Never include the credential or JSON parser error in diagnostics. */ }
  throw new SearchError('configuration', 'Tencent credentials must be a JSON object with non-empty secretId and secretKey strings.');
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const hmac = (key: string | Buffer, text: string): Buffer => createHmac('sha256', key).update(text).digest();

// TC3 canonical headers and the transmitted body must match byte for byte.
// https://cloud.tencent.com/document/api/1806/121816
function signedHeaders(secretId: string, secretKey: string, body: string, timestamp: number): Record<string, string> {
  const host = 'wsa.tencentcloudapi.com';
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/wsa/tc3_request`;
  const signed = 'content-type;host;x-tc-action';
  const canonical = `POST\n/\n\ncontent-type:application/json\nhost:${host}\nx-tc-action:searchpro\n\n${signed}\n${hash(body)}`;
  const toSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`;
  const signingKey = hmac(hmac(hmac(`TC3${secretKey}`, date), 'wsa'), 'tc3_request');
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  return {
    'Content-Type': 'application/json', Host: host,
    'X-TC-Action': 'SearchPro', 'X-TC-Version': '2025-05-08', 'X-TC-Timestamp': String(timestamp),
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  };
}
function providerFailure(code: unknown): SearchError {
  let kind: FailureKind = 'protocol';
  if (typeof code === 'string') {
    if (/^(AuthFailure|UnauthorizedOperation)/.test(code)) kind = 'authentication';
    else if (/^(RequestLimitExceeded|LimitExceeded)/.test(code)) kind = 'rate-limit';
    else if (/^(FailedOperation\.(Balance|Quota)|ResourceUnavailable\.(Balance|Quota))/.test(code)) kind = 'quota';
  }
  return new SearchError(kind, 'Tencent reported an application-level failure; check account permissions, quota, and configuration.');
}

export async function searchTencent(i: AdapterInput, t: TransportOptions): Promise<AdapterResult> {
  if (i.backend.mode !== 'key') throw new SearchError('configuration', 'Tencent Search requires explicitly selected key access.');
  const key = credentials(i.key);
  // This verified TC3 contract signs the official root path, not arbitrary proxy paths or query strings.
  let endpoint: URL;
  try { endpoint = new URL(i.backend.endpoint); }
  catch { throw new SearchError('configuration', 'Tencent endpoint must be the official HTTPS API root.'); }
  if (endpoint.href !== 'https://wsa.tencentcloudapi.com/') {
    throw new SearchError('configuration', 'Tencent endpoint must be the official HTTPS API root.');
  }
  if (!Number.isInteger(i.maxResults) || i.maxResults < 1 || i.maxResults > 50) {
    throw new SearchError('configuration', 'Tencent result count must be an integer between 1 and 50.');
  }
  const mode = i.backend.options.Mode;
  if (mode !== undefined && (typeof mode !== 'number' || ![0, 1, 2].includes(mode))) {
    throw new SearchError('configuration', 'Tencent Mode must be the number 0, 1, or 2.');
  }
  const body = JSON.stringify({ Query: i.query, Cnt: Math.ceil(i.maxResults / 10) * 10, ...(mode === undefined ? {} : { Mode: mode }) });
  const response = object(await requestJson(endpoint.href, {
    method: 'POST', headers: signedHeaders(key.secretId, key.secretKey, body, Math.floor(Date.now() / 1000)), body,
  }, t));
  const result = object(response?.Response);
  if (!result) throw new SearchError('protocol', 'Tencent response is missing its Response envelope.');
  if (result.Error !== undefined) throw providerFailure(object(result.Error)?.Code);
  if (!Array.isArray(result.Pages)) throw new SearchError('protocol', 'Tencent response is missing its Pages array.');
  const sources: Source[] = [];
  for (const encoded of result.Pages) {
    let page: Row | undefined;
    try { page = typeof encoded === 'string' ? object(JSON.parse(encoded)) : undefined; }
    catch { throw new SearchError('protocol', 'Tencent Pages contains invalid JSON.'); }
    if (!page) throw new SearchError('protocol', 'Tencent Pages must contain JSON-encoded objects.');
    if (typeof page.url !== 'string') continue;
    try {
      const url = new URL(page.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    } catch { continue; }
    sources.push({
      url: page.url,
      ...(typeof page.title === 'string' ? { title: page.title } : {}),
      ...(typeof page.passage === 'string' ? { snippet: page.passage } : {}),
      ...(typeof page.content === 'string' ? { summary: page.content } : {}),
      ...(typeof page.date === 'string' ? { publishedAt: page.date } : {}),
    });
  }
  return { sources: sources.slice(0, i.maxResults) };
}
