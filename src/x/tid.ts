// x-client-transaction-id signer: a line-for-line port of bestnite/x-mcp src/tid/*.
//
// Algorithm lineage: iSarabjitDhiman/XClientTransaction (Python) -> Teskann/QuaX (Dart) ->
// bestnite/x-mcp (TypeScript) -> here. The rounding helpers below keep their upstream semantics on
// purpose: jsRound rounds half up, roundTo2 rounds half away from zero (Dart, not Python), and
// floatToHex emits a greedy digit loop. Replacing any of them with a tidier equivalent still
// produces a 94-character id that X simply rejects.
//
// What this reproduces, in order:
//   1. the 48-byte key in <meta name="twitter-site-verification"> on the x.com home page;
//   2. the KEY_BYTE indices dug out of the sign module, which pick an animation row;
//   3. the loading-x-anim SVG path for that row, evaluated as a cubic-bezier animation key;
//   4. tid = base64(randomByte || (keyBytes + timeNow + sha256(...)[0..16] + 3) XOR randomByte).
//
// Failure split matters to the caller: ClientTransactionIdError means X changed the page or the
// chain (a maintainer problem), SourceFetchError means the fetch itself failed (retry or auth).

import { createHash, randomInt } from 'node:crypto';

/** Fixed suffix mixed into the hash; hardcoded in the X front end. */
export const DEFAULT_KEYWORD = 'obfiowerehiring';

/** Constant appended to the payload. Not a random number, despite the upstream name. */
export const ADDITIONAL_RANDOM_NUMBER = 3;

/** Matches the `(e[27], 16)+(e[4], 16)+...` sequence the sign module keys its bytes with. */
export const INDICES_REGEX = /\(\w{1}\[(\d{1,2})\],\s*16\)+/g;

/** Home page -> entry-client bundle. */
export const ENTRY_SCRIPT_REGEX =
  /["'](https:\/\/abs\.twimg\.com\/[^"']+\/entry-client[\w-]*\.js)["']/;

/** Entry bundle -> sign module importer (startup-dynamic / client-transaction-id-plugin). */
export const SIGN_IMPORTER_REGEX =
  /["']([./\w-]*(?:client-transaction-id-plugin|startup-dynamic)-[\w-]+\.js)["']/;

/** Importer -> the sign module itself. */
export const SIGN_FILE_REGEX = /["'`]([./\w-]*sign\.o-[\w-]+\.js)["'`]/;

/** Browser-shaped headers for the signer's own page fetches; they carry no session cookie. */
export const BROWSER_HEADERS: Record<string, string> = {
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Referer: 'https://x.com',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'X-Twitter-Active-User': 'yes',
  'X-Twitter-Client-Language': 'en',
};

export const PAGE_URL = 'https://x.com/home';

/** Signer's own fetch needs nothing else from the caller. */
export interface SignerTransport {
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  timeoutMs: number;
}

export type TextFetcher = (url: string) => Promise<string>;

export interface TIDOptions {
  randomKeyword?: string;
  randomNumber?: number;
}

/** Raw x.com home page and sign module text, so tests can replay a recording. */
export interface TIDSources {
  homePageHtml: string;
  signFileText: string;
}

/** Page or sign-chain problem: the adapter needs updating, not a retry. */
export class ClientTransactionIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientTransactionIdError';
  }
}

/** Transport problem while fetching the signer's inputs; retryable. */
export class SourceFetchError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'SourceFetchError';
    this.statusCode = statusCode;
  }
}

/** Time base: X offsets its clock against a fixed epoch near 2023-05-01. */
export const TIME_EPOCH_SECONDS = 1682924400;
/** Length of one animation cycle in the same unit as frameTime. */
const TOTAL_TIME = 4096;

/** CSS-style cubic-bezier evaluation, copied from the upstream binary-search loop. */
class Cubic {
  constructor(private readonly curves: number[]) {}

  getValue(time: number): number {
    const [c0 = 0, c1 = 0, c2 = 0, c3 = 0] = this.curves;
    let startGradient = 0;
    let endGradient = 0;
    let start = 0;
    let mid = 0;
    let end = 1;

    if (time <= 0) {
      if (c0 > 0) {
        startGradient = c1 / c0;
      } else if (c1 === 0 && c2 > 0) {
        startGradient = c3 / c2;
      }
      return startGradient * time;
    }

    if (time >= 1) {
      if (c2 < 1) {
        endGradient = (c3 - 1) / (c2 - 1);
      } else if (c2 === 1 && c0 < 1) {
        endGradient = (c1 - 1) / (c0 - 1);
      }
      return 1 + endGradient * (time - 1);
    }

    while (start < end) {
      mid = (start + end) / 2;
      const xEst = Cubic.calculate(c0, c2, mid);
      // The convergence threshold must match upstream, or the sampled frame value drifts.
      if (Math.abs(time - xEst) < 0.00001) return Cubic.calculate(c1, c3, mid);
      if (xEst < time) {
        start = mid;
      } else {
        end = mid;
      }
    }
    return Cubic.calculate(c1, c3, mid);
  }

  private static calculate(a: number, b: number, m: number): number {
    return 3 * a * (1 - m) * (1 - m) * m + 3 * b * (1 - m) * m * m + m * m * m;
  }
}

/** Linear array interpolation; mismatched lengths are a programming error upstream too. */
function interpolate(from: number[], to: number[], f: number): number[] {
  if (from.length !== to.length) {
    throw new ClientTransactionIdError(
      `Mismatched interpolation arguments: ${from.length} vs ${to.length}`,
    );
  }
  return from.map((value, i) => value * (1 - f) + (to[i] ?? 0) * f);
}

/** Rotation in degrees to a 2x2 matrix, unrolled row by row. */
function convertRotationToMatrix(rotation: number): number[] {
  const rad = (rotation * Math.PI) / 180;
  return [Math.cos(rad), -Math.sin(rad), Math.sin(rad), Math.cos(rad)];
}

/** JS rounding: halves toward +Infinity (-2.5 -> -2). */
function jsRound(num: number): number {
  return Math.round(num);
}

/** Two decimals, halves away from zero (Dart's round(), not Python's banker's rounding). */
function roundTo2(value: number): number {
  const scaled = value * 100;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return rounded / 100;
}

/** Odd -> -1, even -> 0; the interpolation curve's start value. */
function isOdd(num: number): number {
  return num % 2 !== 0 ? -1 : 0;
}

/**
 * Non-negative float to hex with a fractional part (2.75 -> "2.C").
 *
 * Number.prototype.toString(16) cannot be used: JS picks its own precision and case, while X's
 * algorithm depends on the exact digit count this greedy loop produces.
 */
export function floatToHex(x: number): string {
  const result: string[] = [];
  const fraction = x - Math.trunc(x);
  let quotient = Math.trunc(x);
  let current = x;

  while (quotient > 0) {
    quotient = Math.trunc(current / 16);
    const remainder = Math.trunc(current - quotient * 16);
    result.unshift(remainder > 9 ? String.fromCharCode(remainder + 55) : String(remainder));
    current = quotient;
  }

  if (fraction === 0) return result.join('');

  result.push('.');
  let frac = fraction;
  while (frac > 0) {
    frac *= 16;
    const integer = Math.trunc(frac);
    frac -= integer;
    result.push(integer > 9 ? String.fromCharCode(integer + 55) : String(integer));
  }

  return result.join('');
}

/** Unmask a tid back to its payload: skip the first random byte, XOR the rest with it. */
export function payloadOf(transactionId: string): Buffer {
  const bytes = Buffer.from(transactionId, 'base64');
  const mask = bytes[0] ?? 0;
  return Buffer.from(bytes.subarray(1).map((b) => b ^ mask));
}

/** Text fetcher over an injected transport: page reads honour the caller's deadline. */
export function textFetcher(transport: SignerTransport): TextFetcher {
  return async (url: string): Promise<string> => {
    // Guest pages carry the same meta key and animation frames, so a redirect to the login wall is
    // harmless here; cookie validity is judged by the API calls, not by this fetch.
    const response = await transport.fetchImpl(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.any([transport.signal, AbortSignal.timeout(transport.timeoutMs)]),
    });
    if (!response.ok) {
      throw new SourceFetchError(`GET ${url} returned HTTP ${response.status}`, response.status);
    }
    return response.text();
  };
}

export class ClientTransaction {
  private constructor(
    private readonly keyBytes: readonly number[],
    private readonly animationKey: string,
    private readonly randomKeyword: string,
    private readonly randomNumber: number,
  ) {}

  /** Fetch the x.com page chain and build the signer from it. */
  static async initialize(
    fetch: TextFetcher,
    options: TIDOptions = {},
  ): Promise<ClientTransaction> {
    const sources = await ClientTransaction.fetchSources(fetch);
    return ClientTransaction.fromSources({ ...sources, ...options });
  }

  /** Home page -> entry bundle -> sign importer -> sign module. */
  static async fetchSources(fetch: TextFetcher): Promise<TIDSources> {
    const homePageHtml = await fetch(PAGE_URL);
    const entryUrl = resolveImport(
      new URL('https://x.com/'),
      homePageHtml,
      ENTRY_SCRIPT_REGEX,
      'entry script',
    );
    const entryText = await fetch(entryUrl);
    const importerUrl = resolveImport(
      new URL(entryUrl),
      entryText,
      SIGN_IMPORTER_REGEX,
      'sign module importer',
    );
    const importerText = await fetch(importerUrl);
    const signUrl = resolveImport(new URL(importerUrl), importerText, SIGN_FILE_REGEX, 'sign module');
    const signFileText = await fetch(signUrl);
    return { homePageHtml, signFileText };
  }

  /** Build from already-fetched text; sends no request. */
  static fromSources(input: TIDSources & TIDOptions): ClientTransaction {
    const { homePageHtml, signFileText } = input;
    try {
      const { rowIndex, keyBytesIndices } = getIndices(signFileText);
      const keyBytes = getKeyBytes(getKey(homePageHtml));
      const animationKey = computeAnimationKey({
        keyBytes,
        rowIndex,
        keyBytesIndices,
        homePageHtml,
      });
      return new ClientTransaction(
        keyBytes,
        animationKey,
        input.randomKeyword ?? DEFAULT_KEYWORD,
        input.randomNumber ?? ADDITIONAL_RANDOM_NUMBER,
      );
    } catch (error) {
      if (error instanceof ClientTransactionIdError) throw error;
      throw new ClientTransactionIdError(
        `Couldn't read the page and the sign module: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Produce the x-client-transaction-id for one request.
   *
   * Payload layout (69 bytes, 94 base64 characters with the padding stripped):
   *
   *   [0]      random mask byte, fresh on every call, so two tids for one request differ
   *   [1..48]  the 48-byte key from <meta name="twitter-site-verification">
   *   [49..52] timeNow as 4 little-endian bytes
   *   [53..68] first 16 bytes of sha256("METHOD!path!timeNow" + keyword + animationKey)
   *   [69]     the constant 3 (not a random number)
   *
   * Every byte above is XORed with the mask byte, so comparing two tids requires payloadOf().
   * method/path belong to the request being signed, which is why this is called per request.
   */
  generateTransactionId(method: string, path: string, now: Date = new Date()): string {
    const timeNow = Math.floor((now.getTime() - TIME_EPOCH_SECONDS * 1000) / 1000);
    const timeNowBytes = Array.from({ length: 4 }, (_, i) => (timeNow >> (i * 8)) & 0xff);

    const hashInput = `${method}!${path}!${timeNow}${this.randomKeyword}${this.animationKey}`;
    const hashBytes = createHash('sha256').update(hashInput, 'utf8').digest();

    const randomNum = randomInt(0, 256);
    const payload = [
      ...this.keyBytes,
      ...timeNowBytes,
      ...hashBytes.subarray(0, 16),
      this.randomNumber,
    ];
    const out = Buffer.alloc(payload.length + 1);
    out[0] = randomNum;
    for (let i = 0; i < payload.length; i++) {
      out[i + 1] = (payload[i] ?? 0) ^ randomNum;
    }

    return out.toString('base64').replace(/=/g, '');
  }
}

// --- internals ---------------------------------------------------------------

function resolveImport(base: URL, text: string, regex: RegExp, what: string): string {
  const match = new RegExp(regex.source, regex.flags).exec(text);
  const path = match?.[1];
  if (!path) throw new ClientTransactionIdError(`Couldn't find the ${what}`);
  return new URL(path, base).toString();
}

/** Read (animation row index, KEY_BYTE indices) out of the sign module. */
function getIndices(signFileText: string): { rowIndex: number; keyBytesIndices: number[] } {
  const indices: number[] = [];
  const regex = new RegExp(INDICES_REGEX.source, INDICES_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(signFileText)) !== null) {
    const index = match[1];
    if (index !== undefined) indices.push(Number(index));
  }
  const rowIndex = indices[0];
  if (rowIndex === undefined) throw new ClientTransactionIdError("Couldn't get KEY_BYTE indices");
  return { rowIndex, keyBytesIndices: indices.slice(1) };
}

/** The 48-byte verification key from the home page. */
function getKey(html: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/name=["']twitter-site-verification["']/i.test(tag)) continue;
    const content = /content=["']([^"']+)["']/i.exec(tag)?.[1];
    if (content) return content;
  }
  throw new ClientTransactionIdError(
    "Couldn't get [twitter-site-verification] key from the page source",
  );
}

function getKeyBytes(key: string): number[] {
  const bytes = Buffer.from(key, 'base64');
  if (bytes.length === 0) throw new ClientTransactionIdError("Couldn't decode the verification key");
  return [...bytes];
}

/** Pull one loading-x-anim animation path out as a 2D numeric array. */
function get2dArray(keyBytes: readonly number[], html: string): number[][] {
  const frames = [
    ...html.matchAll(/<svg\b[^>]*\bid=["']loading-x-anim[^"']*["'][^>]*>([\s\S]*?)<\/svg>/gi),
  ].map((m) => m[1] ?? '');
  if (frames.length === 0) {
    throw new ClientTransactionIdError("Couldn't find the loading-x-anim frames");
  }

  const frame = frames[(keyBytes[5] ?? 0) % 4];
  if (frame === undefined) {
    throw new ClientTransactionIdError('The animation frame index is out of range');
  }

  // The second path in each frame is the animation; the first is the X logo.
  const paths = [...frame.matchAll(/<path\b[^>]*\bd=["']([^"']*)["']/gi)].map((m) => m[1] ?? '');
  const d = paths[1];
  if (d === undefined) throw new ClientTransactionIdError("Couldn't find the animation path");

  // Three parsing steps, each of which has bitten before:
  // 1. substring(9) drops the literal "M 10,30 C" prefix by position, the way upstream does;
  // 2. split on 'C' yields one cubic-bezier segment per row;
  // 3. every number in a row is data, including coordinates after h/s commands. Filtering those
  //    out shifts every later column and the resulting key never matches.
  return d
    .substring(9)
    .split('C')
    .map((segment) =>
      segment
        .replace(/[^\d]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((s) => s.length > 0)
        .map(Number),
    )
    .filter((row) => row.length > 0);
}

function solve(value: number, minVal: number, maxVal: number, rounding: boolean): number {
  const result = (value * (maxVal - minVal)) / 255 + minVal;
  return rounding ? Math.floor(result) : roundTo2(result);
}

function animate(frames: number[], targetTime: number): string {
  // Upstream assumes at least 11 values per row (7 colour/rotation + 4 curve points).
  const at = (index: number): number => frames[index] ?? 0;

  const fromColor = [at(0), at(1), at(2), 1];
  const toColor = [at(3), at(4), at(5), 1];
  const fromRotation = [0];
  const toRotation = [solve(at(6), 60, 360, true)];

  const curves = frames.slice(7).map((value, index) => solve(value, isOdd(index), 1, false));

  const cubic = new Cubic(curves);
  const val = cubic.getValue(targetTime);

  const color = interpolate(fromColor, toColor, val).map((v) => Math.min(Math.max(v, 0), 255));
  const rotation = interpolate(fromRotation, toRotation, val);
  const matrix = convertRotationToMatrix(rotation[0] ?? 0);

  const parts: string[] = [];
  for (let i = 0; i < color.length - 1; i++) {
    // Channels are clamped to 0-255, so Math.round matches Dart's round() here.
    parts.push(Math.round(color[i] ?? 0).toString(16));
  }
  for (const value of matrix) {
    let rounded = roundTo2(value);
    if (rounded < 0) rounded = -rounded;
    const hexValue = floatToHex(rounded);
    if (hexValue.startsWith('.')) {
      parts.push(`0${hexValue}`.toLowerCase());
    } else if (hexValue.length > 0) {
      parts.push(hexValue);
    } else {
      parts.push('0');
    }
  }
  parts.push('0', '0');

  return parts.join('').replace(/[.-]/g, '');
}

function computeAnimationKey(input: {
  keyBytes: readonly number[];
  rowIndex: number;
  keyBytesIndices: readonly number[];
  homePageHtml: string;
}): string {
  const { keyBytes, rowIndex, keyBytesIndices, homePageHtml } = input;
  // Two different indices are in play; swapping them still produces a 94-character id that X
  // rejects outright:
  // - keyBytes[rowIndex] (rowIndex from the sign module's first index) selects the animation row;
  // - keyBytes[5] selects which loading-x-anim element to read.
  const frameRowIndex = (keyBytes[rowIndex] ?? 0) % 16;
  const frameTimeProduct = keyBytesIndices.reduce((acc, idx) => acc * ((keyBytes[idx] ?? 0) % 16), 1);
  const frameTime = jsRound(frameTimeProduct / 10) * 10;

  const rows = get2dArray(keyBytes, homePageHtml);
  const frameRow = rows[frameRowIndex];
  if (frameRow === undefined) {
    throw new ClientTransactionIdError(
      `The animation row ${frameRowIndex} is out of range (only ${rows.length} rows)`,
    );
  }
  return animate(frameRow, frameTime / TOTAL_TIME);
}
