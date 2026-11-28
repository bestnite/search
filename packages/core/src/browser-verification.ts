import { loadPlaywright } from './playwright-driver.js';
import { catalog } from './catalog.js';
import { parseBrowserEndpoint } from './browser-endpoint.js';
import type { ConfigIssue, ConfigIssueParams, SearchConfig } from './types.js';

/**
 * Save-time evidence that every enabled browser dependency can actually be reached.
 *
 * The probe is deliberately smaller than a read: attach, create one isolated context, close that
 * context, disconnect. It never navigates, never runs a site script and never borrows the shared
 * `BrowserSession`, so a copy of a signed-in page is impossible. `close()` on a browser obtained by
 * `connect()` clears the contexts this connection created and disconnects; it does not stop the
 * browser server other clients are using.
 *
 * The bound is one total deadline for the whole save (default five seconds), not one timeout per
 * step, so a slow server cannot turn a save into a long hang. A resource that arrives after the
 * deadline is closed on arrival instead of leaking.
 */

export const BROWSER_VERIFICATION_TIMEOUT_MS = 5_000;

/** One enabled configuration switch that would attach to a browser. */
export interface BrowserDependency {
  /** Configuration path of the switch that makes the dependency active. */
  path: string;
  /** Where the settings page should reveal the fix. */
  target: string;
  kind: 'search-backend' | 'fetch-browser-route';
  /** Provider id, or `browser` for the shared page-fetch route. */
  id: string;
  /**
   * The endpoint the dependency would use right now. Search readers prefer the shared endpoint and
   * fall back to their own; the fetch browser route uses the shared endpoint only.
   */
  endpoint: string;
}

export interface BrowserVerificationCheck {
  endpoint: string;
  ok: boolean;
  /** Stable reason when the check failed; absent when it succeeded. */
  code?: string;
  durationMs: number;
  /** Bounded transport detail for the settings page, never a token. */
  detail?: string;
}

export interface BrowserVerificationResult {
  ok: boolean;
  checks: BrowserVerificationCheck[];
  issues: ConfigIssue[];
}

/** The slice of a Playwright `Browser` the probe needs, so tests can drive it without a server. */
export interface VerificationBrowser {
  newContext(options?: Record<string, unknown>): Promise<VerificationContext>;
  close(): Promise<void>;
}
export interface VerificationContext {
  close(): Promise<void>;
}
export type VerificationConnect = (endpoint: string, options: { timeout: number; headers?: Record<string, string> }) => Promise<VerificationBrowser>;

export const defaultVerificationConnect: VerificationConnect = async (endpoint, options) => {
  const { chromium } = await loadPlaywright();
  return chromium.connect(endpoint, options) as unknown as Promise<VerificationBrowser>;
};

export interface VerificationOptions {
  /** Reads the stored endpoint token. The value never enters an issue, a check or a log line. */
  resolveToken?: () => string | undefined | Promise<string | undefined>;
  connect?: VerificationConnect;
  timeoutMs?: number;
  now?: () => number;
  /** Cancels the check, including a connection that is still attaching. */
  signal?: AbortSignal;
}

/** Every enabled browser dependency, with the endpoint effective right now. */
export function collectBrowserDependencies(config: SearchConfig): BrowserDependency[] {
  const dependencies: BrowserDependency[] = [];
  for (const definition of catalog) {
    const row = config.backends[definition.id];
    if (!row || !row.enabled || row.mode !== 'browser') continue;
    // Exactly the adapter's precedence: the shared endpoint wins while it is filled in, and the
    // backend's own endpoint is only a fallback.
    const endpoint = config.browser.endpoint || row.endpoint;
    dependencies.push({ path: `backends.${definition.id}.enabled`, target: 'browser.endpoint', kind: 'search-backend', id: definition.id, endpoint });
  }
  config.pageFetch.routes.forEach((route, index) => {
    if (route.kind !== 'browser' || !route.enabled) return;
    // The page-fetch browser route reads only `browser.endpoint`; it never borrows a search
    // backend's private fallback, so a fallback cannot make the fetch route appear verified.
    dependencies.push({ path: `pageFetch.routes.${index}.enabled`, target: 'browser.endpoint', kind: 'fetch-browser-route', id: 'browser', endpoint: config.browser.endpoint });
  });
  return dependencies;
}

class VerificationTimeout extends Error {}

/** The caller cancelled the check. A cancellation is never a pass. */
export class BrowserVerificationAborted extends Error {
  constructor() {
    super('The browser check was cancelled.');
    this.name = 'BrowserVerificationAborted';
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Run one promise under a deadline; a value that arrives late is handed to `onLate` for cleanup. */
function bounded<T>(operation: Promise<T>, timeoutMs: number, onLate: (value: T) => void, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    const timer = setTimeout(() => {
      if (settle()) reject(new VerificationTimeout());
    }, Math.max(1, timeoutMs));
    const onAbort = (): void => {
      if (settle()) reject(new BrowserVerificationAborted());
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => {
        if (!settle()) { onLate(value); return; }
        resolve(value);
      },
      error => {
        if (!settle()) return;
        reject(error);
      },
    );
  });
}

const closeQuietly = (value: { close(): Promise<void> }): void => {
  try { void Promise.resolve(value.close()).catch(() => undefined); } catch { /* best effort */ }
};

/** Teardown that cannot extend the save beyond the shared deadline; a slow close is abandoned. */
const closeBounded = async (value: { close(): Promise<void> }, remaining: () => number): Promise<void> => {
  try { await bounded(Promise.resolve().then(() => value.close()), remaining(), () => undefined); } catch { /* best effort */ }
};

type ProbeFailure = { ok: false; code: string; params: ConfigIssueParams; detail: string };
type ProbeResult = { ok: true; durationMs: number } | (ProbeFailure & { durationMs: number });

/** Classify a connection failure without ever echoing a token. */
function classifyConnectFailure(error: unknown, endpoint: string): ProbeFailure {
  const text = message(error);
  const params: ConfigIssueParams = { endpoint };
  if (/version mismatch/i.test(text) || /\b428\b/.test(text)) {
    return { ok: false, code: 'browser.protocolMismatch', params, detail: text.slice(0, 200) };
  }
  if (/\b401\b|unauthori[sz]ed|invalid_auth|authentication/i.test(text)) {
    return { ok: false, code: 'browser.authRejected', params, detail: 'The endpoint rejected the stored token.' };
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET/i.test(text)) {
    return { ok: false, code: 'browser.unreachable', params, detail: 'No browser server answered at this endpoint.' };
  }
  return { ok: false, code: 'browser.connectFailed', params, detail: text.slice(0, 200) };
}

/** Attach, prove an isolated context can be created, close everything this probe created. */
async function probeEndpoint(endpoint: string, token: string | undefined, timeoutMs: number, connect: VerificationConnect, now: () => number, signal?: AbortSignal): Promise<ProbeResult> {
  const scrub = (text: string): string => (token ? text.split(token).join('[redacted]') : text).slice(0, 200);
  const started = now();
  const deadline = started + timeoutMs;
  const remaining = (): number => deadline - now();
  let browser: VerificationBrowser | undefined;
  try {
    browser = await bounded(
      connect(endpoint, { ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), timeout: Math.max(1, remaining()) }),
      remaining(),
      late => closeQuietly(late),
      signal,
    );
  } catch (error) {
    if (error instanceof BrowserVerificationAborted) throw error;
    if (error instanceof VerificationTimeout) return { ok: false, code: 'browser.timeout', params: { endpoint, timeoutMs }, detail: 'The browser endpoint did not answer within the bounded save check.', durationMs: now() - started };
    const failure = classifyConnectFailure(error, endpoint);
    return { ...failure, detail: scrub(failure.detail), durationMs: now() - started };
  }
  try {
    const context = await bounded(browser.newContext({}), remaining(), late => closeQuietly(late), signal);
    await closeBounded(context, remaining);
    return { ok: true, durationMs: now() - started };
  } catch (error) {
    if (error instanceof BrowserVerificationAborted) throw error;
    if (error instanceof VerificationTimeout) return { ok: false, code: 'browser.timeout', params: { endpoint, timeoutMs }, detail: 'The browser accepted the connection but did not create a context within the bounded save check.', durationMs: now() - started };
    return { ok: false, code: 'browser.contextFailed', params: { endpoint }, detail: scrub(message(error)), durationMs: now() - started };
  } finally {
    // A connected browser is disconnected here; the server process and other clients stay alive.
    await closeBounded(browser, remaining);
  }
}

const issueFor = (dependency: BrowserDependency, code: string, params: ConfigIssueParams, detail: string): ConfigIssue => ({
  path: dependency.path,
  message: (code === 'browser.endpoint.missing'
    ? 'An enabled browser-dependent feature has no endpoint to attach to.'
    : code === 'browser.endpoint.invalid'
      ? 'The effective browser endpoint is not a WS(S) Playwright endpoint.'
      : 'The enabled browser-dependent feature could not verify its browser endpoint.') + (detail ? ` ${detail}` : ''),
  code,
  params: {
    ...params,
    ...(dependency.kind === 'search-backend' ? { backend: dependency.id, kind: 'search-backend' } : { route: 'browser', kind: 'fetch-browser-route' }),
  },
  action: { target: dependency.target },
});

/**
 * Verify every enabled browser dependency for a save. Identical endpoint/token pairs share one probe;
 * a group failure produces one actionable issue per dependent switch. No dependencies means no
 * network access at all, so browser settings can be saved offline while every dependent is off.
 */
export async function verifyBrowserDependencies(config: SearchConfig, options: VerificationOptions = {}): Promise<BrowserVerificationResult> {
  const dependencies = collectBrowserDependencies(config);
  if (!dependencies.length) return { ok: true, checks: [], issues: [] };
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? BROWSER_VERIFICATION_TIMEOUT_MS;
  const signal = options.signal;
  if (signal?.aborted) throw new BrowserVerificationAborted();
  const deadline = now() + timeoutMs;
  const remaining = (): number => Math.max(1, deadline - now());
  const issues: ConfigIssue[] = [];
  const checks: BrowserVerificationCheck[] = [];
  const probeable: BrowserDependency[] = [];
  for (const dependency of dependencies) {
    if (!dependency.endpoint) issues.push(issueFor(dependency, 'browser.endpoint.missing', {}, 'No effective endpoint.'));
    else if (!parseBrowserEndpoint(dependency.endpoint)) issues.push(issueFor(dependency, 'browser.endpoint.invalid', { endpoint: dependency.endpoint }, 'Not a WS(S) URL.'));
    else probeable.push(dependency);
  }
  if (!probeable.length) return { ok: false, checks, issues };
  let token: string | undefined;
  try {
    // Resolving the token is part of the same bounded window; a slow credential store must not
    // turn a save into an unbounded wait, and a timeout is a refusal rather than a pass.
    token = options.resolveToken ? await bounded(Promise.resolve().then(() => options.resolveToken!()), remaining(), () => undefined, signal) : undefined;
  } catch (error) {
    if (error instanceof BrowserVerificationAborted) throw error;
    if (error instanceof VerificationTimeout) {
      for (const dependency of probeable) issues.push(issueFor(dependency, 'browser.timeout', { timeoutMs }, 'The stored endpoint token could not be read within the bounded save check.'));
      return { ok: false, checks, issues };
    }
    // A credential-store failure is not a browser verdict and must never let the save through.
    throw error;
  }
  const groups = new Map<string, BrowserDependency[]>();
  for (const dependency of probeable) {
    const existing = groups.get(dependency.endpoint);
    if (existing) existing.push(dependency);
    else groups.set(dependency.endpoint, [dependency]);
  }
  for (const [endpoint, group] of groups) {
    if (signal?.aborted) throw new BrowserVerificationAborted();
    const result = await probeEndpoint(endpoint, token, remaining(), options.connect ?? defaultVerificationConnect, now, signal);
    checks.push({
      endpoint,
      ok: result.ok,
      durationMs: result.durationMs,
      ...(result.ok ? {} : { code: result.code, detail: result.detail }),
    });
    if (!result.ok) for (const dependency of group) issues.push(issueFor(dependency, result.code, result.params, result.detail));
  }
  return { ok: issues.length === 0, checks, issues };
}

/** The manual check: one endpoint, the stored token, the same bounded protocol and cleanup. */
export async function verifyBrowserEndpoint(endpoint: string, options: VerificationOptions = {}): Promise<BrowserVerificationCheck> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? BROWSER_VERIFICATION_TIMEOUT_MS;
  const signal = options.signal;
  if (signal?.aborted) throw new BrowserVerificationAborted();
  if (!endpoint) return { endpoint, ok: false, code: 'browser.endpoint.missing', durationMs: 0 };
  if (!parseBrowserEndpoint(endpoint)) return { endpoint, ok: false, code: 'browser.endpoint.invalid', durationMs: 0 };
  const started = now();
  const deadline = started + timeoutMs;
  const remaining = (): number => Math.max(1, deadline - now());
  let token: string | undefined;
  try {
    token = options.resolveToken ? await bounded(Promise.resolve().then(() => options.resolveToken!()), remaining(), () => undefined, signal) : undefined;
  } catch (error) {
    if (error instanceof VerificationTimeout) return { endpoint, ok: false, code: 'browser.timeout', durationMs: now() - started };
    throw error;
  }
  const result = await probeEndpoint(endpoint, token, remaining(), options.connect ?? defaultVerificationConnect, now, signal);
  return { endpoint, ok: result.ok, durationMs: result.durationMs, ...(result.ok ? {} : { code: result.code, detail: result.detail }) };
}
