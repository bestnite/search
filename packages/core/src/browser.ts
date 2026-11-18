// patchright-core is a patched Playwright: same protocol and API, with the CDP leaks closed.
// Both sides of the connection must share a major.minor, so the browser image pins the same version.
import { chromium, type Browser, type BrowserContext, type Page } from 'patchright-core';
import { existsSync } from 'node:fs';
import { SearchError } from './transport.js';

/**
 * One connection to the browser the user runs. The browser belongs to them: this class never
 * launches anything, never installs anything and never touches the profile — it attaches, reuses
 * its own context and page for the site, and admits a bounded number of concurrent reads.
 */
export interface BrowserSessionOptions {
  /** Playwright server endpoint, for example ws://127.0.0.1:3000/xhs. */
  wsEndpoint: string;
  /** Bearer token checked by the proxy in front of that endpoint. */
  token?: string;
  /** Page the browser is asked to open when it is not on the site yet. */
  siteUrl: string;
  timeoutMs: number;
  /**
   * Where the signed-in session is kept. The login itself happens in that browser over VNC; this
   * file only lets a fresh connection start already signed in.
   */
  statePath?: string;
  /**
   * What this session may do with `statePath`. The default, `read-write`, keeps the old contract:
   * a caller that owns the file may persist it. A session that shares the browser with a process
   * that already writes the file (the keeper in the shipped image) sets `read-only` instead: it
   * loads the file into every new context and never writes it back.
   */
  statePolicy?: 'read-only' | 'read-write';
  /**
   * How many read transactions may be in flight on this site at once. The default of 2 is a
   * deliberately conservative local starting point, not a Xiaohongshu limit and not verified
   * against the live site. Accepted values are integers from 1 through 8; anything else is a
   * configuration error rather than a silent clamp.
   */
  maxConcurrentReads?: number;
  /**
   * Whole shutdown budget for `close()`: the wait for in-flight reads plus the teardown are paid
   * from this one deadline. Defaults to 5000ms.
   */
  closeTimeoutMs?: number;
  /**
   * How long the session may sit idle before it releases its own connection and context. The
   * session object stays usable and reattaches on the next read. `0` disables idle release.
   */
  idleTimeoutMs?: number;
  /** Injected in tests; production attaches with patchright. */
  connect?: (options: BrowserSessionOptions) => Promise<Browser>;
}

/**
 * The only thing a read transaction may do with the page: run one script and report that the
 * cached page/context went stale. A transaction gets no way to close or persist the session,
 * because the session belongs to the process, not to one read.
 */
export interface BrowserReader {
  /** Run one page script while the transaction owns one admission slot. */
  evaluate<T>(script: string): Promise<T>;
  /**
   * Mark this read's page generation stale. Use it when the read proved the page is no longer
   * usable (for example an expired sign-in), not for failures that belong to the subject of the
   * read (a private note). New reads wait for the in-flight generation to drain and then start
   * from the current state file; the failed read itself is never replayed.
   */
  invalidate(): void;
}

interface SessionGeneration {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  inflight: number;
  stale: boolean;
  /** A page-only rebuild keeps the connection and context; a connection recycle drops both. */
  staleReason: 'page' | 'connection' | undefined;
  readonly drained: Promise<void>;
  readonly resolveDrained: () => void;
  readonly drainedResolved: { value: boolean };
  disposal: Promise<void> | undefined;
}

interface Lease {
  readonly generation: SessionGeneration;
  released: boolean;
}

interface ReadJob {
  readonly run: (reader: BrowserReader, page: Page) => Promise<unknown>;
  readonly signal?: AbortSignal;
  started: boolean;
  settled: boolean;
  /** Aborted before admission: the caller already has its answer. */
  cancelled: boolean;
  /** Aborted/closed after admission: the stage in flight finishes before the slot is released. */
  cancelRequested: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

const DEFAULT_IDLE_MS = 300_000;
const DEFAULT_CLOSE_MS = 5_000;
export const DEFAULT_MAX_CONCURRENT_READS = 2;
const MAX_CONCURRENT_READS = 8;
const PERSIST_INTERVAL_MS = 60_000;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const cancelled = (detail: string): SearchError => new SearchError('cancelled', detail);

const defaultConnect = (options: BrowserSessionOptions): Promise<Browser> =>
  chromium.connect(options.wsEndpoint, {
    timeout: options.timeoutMs,
    ...(options.token ? { headers: { authorization: `Bearer ${options.token}` } } : {}),
  });

/**
 * The site owns a page only when the hostname is the configured one, a subdomain of it, or the
 * bare apex when the configured host starts with `www.`. Arbitrary ancestors are refused: with
 * `www.foo.co.uk` configured, `https://com` and `https://co.uk` are not the site. This is
 * deliberately not a public-suffix implementation; the www/apex pair is the only alias allowed.
 * An exactly configured `about:blank` is the one non-http exception, for local page checks.
 */
function sameSite(current: string, target: string): boolean {
  // about:blank is the only non-http target accepted, exactly as configured. It is useful for a
  // local page with no network at all; no other about: URL is treated as a site.
  if (current === 'about:blank' && target === 'about:blank') return true;
  try {
    const page = new URL(current);
    const site = new URL(target);
    if (page.protocol !== 'http:' && page.protocol !== 'https:') return false;
    const a = page.hostname.toLowerCase();
    const b = site.hostname.toLowerCase();
    if (a === b || a.endsWith(`.${b}`)) return true;
    return b.startsWith('www.') && a === b.slice('www.'.length);
  } catch {
    return false;
  }
}

const siteName = (siteUrl: string): string => {
  try {
    return new URL(siteUrl).hostname;
  } catch {
    return 'the site';
  }
};

function createGeneration(browser: Browser, context: BrowserContext, page: Page): SessionGeneration {
  let resolveDrained = (): void => undefined;
  const drained = new Promise<void>(resolve => {
    resolveDrained = resolve;
  });
  const drainedResolved = { value: false };
  return {
    browser,
    context,
    page,
    inflight: 0,
    stale: false,
    staleReason: undefined,
    drained,
    drainedResolved,
    resolveDrained: () => {
      if (drainedResolved.value) return;
      drainedResolved.value = true;
      resolveDrained();
    },
    disposal: undefined,
  };
}

/** Wait for a shared promise, but stop waiting as soon as the caller aborts. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // Do not leave the shared promise without a rejection handler.
    promise.catch(() => undefined);
    return Promise.reject(cancelled('The browser read was cancelled while waiting for the session.'));
  }
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => {
      signal.removeEventListener('abort', stop);
      reject(cancelled('The browser read was cancelled while waiting for the session.'));
    };
    signal.addEventListener('abort', stop, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', stop);
        reject(error);
      },
    );
  });
}

/** Wait at most `timeoutMs`; a rejected or timed-out operation is reported as incomplete. */
async function bounded(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const result = await Promise.race([operation.then(() => true, () => true), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

/**
 * One kept browser connection per site.
 *
 * Reads are transactions. Up to `maxConcurrentReads` of them may be in flight on the same page;
 * an admission limiter shared by every read API keeps that bound and a FIFO waiter list keeps
 * admission fair. A transaction is health probe plus the page script plus mapping, so the two
 * stages of different transactions can interleave while each result still belongs to its own
 * async call.
 *
 * The page belongs to a generation with an in-flight reference count. Initialisation is
 * single-flight. A stale generation (expired sign-in, lost connection, closed tab) stops admitting
 * new reads, lets its in-flight reads finish, and is disposed before the next generation opens.
 * The only things that release resources are an idle timeout, an explicit shutdown and that
 * generation recycle. The window a human signs into belongs to the keeper's separate client, not
 * to this context, and nothing here touches it.
 */
export class BrowserSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private savedAt = 0;
  private generation: SessionGeneration | undefined;
  private opening: Promise<SessionGeneration> | undefined;
  private disposal: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private idleDisposed = false;
  private idleRunning = false;
  private retired = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private admissionLimit: number;
  private activeCount = 0;
  private waiters: ReadJob[] = [];
  private readonly activeJobs = new Set<ReadJob>();
  private readonly zeroWaiters: Array<() => void> = [];
  private pumping = false;
  private maintenance: Promise<void> | undefined;
  private maintenanceRequested = false;
  private maintenanceRunning = false;
  private readonly shutdown = new AbortController();

  constructor(
    private readonly options: BrowserSessionOptions,
    /** Called after the session released its resources; the registry drops the idle entry. */
    private readonly onDisposed?: () => void,
  ) {
    const limit = options.maxConcurrentReads ?? DEFAULT_MAX_CONCURRENT_READS;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONCURRENT_READS) {
      throw new SearchError(
        'configuration',
        `maxConcurrentReads must be an integer from 1 through ${MAX_CONCURRENT_READS}; it is a local safety bound, not a Xiaohongshu quota.`,
      );
    }
    this.admissionLimit = limit;
  }

  get isClosed(): boolean {
    return this.closed || this.retired;
  }

  /**
   * Run one read transaction. The callback gets a narrow reader and owns one admission slot from
   * before its first page operation until it settles. An abort that arrives while the transaction
   * is waiting rejects at once; an abort that arrives while a page call is in flight is observed
   * before the next operation, because a browser call cannot be interrupted mid-flight.
   */
  async read<T>(run: (reader: BrowserReader) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue((reader, _page) => run(reader), signal);
  }

  /** Legacy single-script entry point. It now uses the same admission limiter as `read`. */
  async evaluate<T>(script: string): Promise<T> {
    return this.read(reader => reader.evaluate<T>(script));
  }

  /** Legacy way to get the page. The admission slot is released before the caller uses it. */
  async target(): Promise<Page> {
    return this.enqueue((_reader, page) => Promise.resolve(page));
  }

  /**
   * Persist the session so the next process starts signed in. Runs as exclusive maintenance:
   * admission pauses and waits for in-flight reads to settle first. Skipped in `read-only` mode,
   * rate-limited, and `savedAt` moves only after a save actually succeeded.
   *
   * Do not call this from inside a read transaction; it waits for the transaction to finish.
   */
  async persist(): Promise<void> {
    if (this.closed || this.retired || this.options.statePolicy === 'read-only') return;
    await this.runMaintenance(async () => {
      await this.persistUnlocked();
    }).catch(() => undefined);
  }

  /**
   * Close this session for good. New reads are refused, queued reads are cancelled, in-flight
   * reads get a bounded grace period (one total deadline with the teardown), and the connection is
   * dropped even if a read is still stuck. Idempotent, including when called concurrently.
   */
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.shutdown.abort();
    this.clearIdleTimer();
    this.cancelWaiters();
    this.closing = this.disposeAfterClose().catch(() => undefined);
    return this.closing;
  }

  // --- admission -----------------------------------------------------------------------------

  private enqueue<T>(run: (reader: BrowserReader, page: Page) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed || this.retired || this.closing) {
      return Promise.reject(cancelled(
        this.retired
          ? 'The browser session was retired after idling out; ask the registry for the current session.'
          : 'The browser session was closed before this read started.',
      ));
    }
    if (signal?.aborted) {
      return Promise.reject(cancelled('The browser read was cancelled before it started.'));
    }
    return new Promise<T>((resolve, reject) => {
      let job: ReadJob;
      const onAbort = (): void => {
        if (job.settled) return;
        if (!job.started) {
          job.cancelled = true;
          job.reject(cancelled('The queued browser read was cancelled.'));
          this.pump();
          return;
        }
        job.cancelRequested = true;
      };
      job = {
        run: run as (reader: BrowserReader, page: Page) => Promise<unknown>,
        ...(signal ? { signal } : {}),
        started: false,
        settled: false,
        cancelled: false,
        cancelRequested: false,
        resolve: value => {
          if (job.settled) return;
          job.settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(value as T);
        },
        reject: error => {
          if (job.settled) return;
          job.settled = true;
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(job);
      this.pump();
    });
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (
        !this.closed &&
        !this.retired &&
        !this.idleRunning &&
        !this.maintenanceRequested &&
        !this.maintenanceRunning &&
        this.activeCount < this.admissionLimit
      ) {
        const job = this.waiters.shift();
        if (!job) break;
        if (job.cancelled) continue;
        job.started = true;
        this.activeCount += 1;
        this.activeJobs.add(job);
        this.idleDisposed = false;
        this.clearIdleTimer();
        void this.runJob(job);
      }
    } finally {
      this.pumping = false;
    }
    this.afterActivity();
  }

  private async runJob(job: ReadJob): Promise<void> {
    let lease: Lease | undefined;
    try {
      lease = await this.acquireLease(this.readSignal(job.signal));
      if (this.closed || this.retired) throw cancelled('The browser session was closed.');
      if (job.signal?.aborted || job.cancelRequested) throw cancelled('The browser read was cancelled.');
      const reader = this.readerFor(job, lease);
      const value = await job.run(reader, lease.generation.page);
      if (job.cancelRequested) throw cancelled('The browser read was cancelled; the operation in flight was allowed to finish.');
      job.resolve(value);
    } catch (error) {
      // A rate-limit answer means the site pushed back. Keep this session at one concurrent read
      // for the rest of its life; in-flight reads are not interrupted and nothing is replayed.
      if (error instanceof SearchError && error.kind === 'rate-limit') this.lowerAdmission();
      job.reject(
        job.cancelRequested && !(error instanceof SearchError && error.kind === 'cancelled')
          ? cancelled('The browser read was cancelled; the operation in flight was allowed to finish.')
          : error,
      );
    } finally {
      if (lease) this.releaseLease(lease);
      this.activeJobs.delete(job);
      this.activeCount = Math.max(0, this.activeCount - 1);
      if (this.activeCount === 0) this.resolveZeroWaiters();
      this.pump();
      this.afterActivity();
    }
  }

  private readSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
  }

  private lowerAdmission(): void {
    // Conservative local slowdown, held until this BrowserSession is replaced. It is not a claimed
    // official quota or cooldown and does not auto-recover on a page/context rebuild.
    if (this.admissionLimit !== 1) this.admissionLimit = 1;
  }

  // --- generation ----------------------------------------------------------------------------

  private async acquireLease(signal: AbortSignal): Promise<Lease> {
    for (;;) {
      if (this.closed || this.retired) throw cancelled('The browser session was closed.');
      const generation = await this.ensureGeneration(signal);
      if (this.closed || this.retired) throw cancelled('The browser session was closed.');
      if (generation.stale) {
        await abortable(this.disposeGeneration(generation), signal);
        continue;
      }
      // A tab closed or a connection lost between generations is noticed here, before a new read
      // is bound to it, and rebuilt without failing the caller.
      if (!generation.browser.isConnected()) {
        this.markGenerationStale(generation, 'connection');
        await abortable(this.disposeGeneration(generation), signal);
        continue;
      }
      if (generation.page.isClosed()) {
        this.markGenerationStale(generation, 'page');
        await abortable(this.disposeGeneration(generation), signal);
        continue;
      }
      generation.inflight += 1;
      if (this.closed || this.retired || this.generation !== generation || generation.stale) {
        this.releaseLease({ generation, released: false });
        if (this.closed || this.retired) throw cancelled('The browser session was closed.');
        continue;
      }
      return { generation, released: false };
    }
  }

  private async ensureGeneration(signal: AbortSignal): Promise<SessionGeneration> {
    for (;;) {
      if (this.closed || this.retired) throw cancelled('The browser session was closed.');
      const current = this.generation;
      if (current?.stale) {
        await abortable(this.disposeGeneration(current), signal);
        continue;
      }
      if (current) return current;
      if (this.disposal) {
        await abortable(this.disposal, signal);
        continue;
      }
      if (!this.opening) {
        const opening = this.openGeneration();
        this.opening = opening;
        void opening
          .finally(() => {
            if (this.opening === opening) this.opening = undefined;
            this.afterActivity();
          })
          .catch(() => undefined);
      }
      const opening = this.opening;
      const generation = await abortable(opening, signal);
      if (this.closed || this.retired) throw cancelled('The browser session was closed.');
      if (generation.stale) continue;
      return generation;
    }
  }

  private releaseLease(lease: Lease): void {
    if (lease.released) return;
    lease.released = true;
    const generation = lease.generation;
    generation.inflight = Math.max(0, generation.inflight - 1);
    if (generation.stale && generation.inflight === 0) {
      generation.resolveDrained();
      void this.beginDisposal(generation);
    }
  }

  private markGenerationStale(generation: SessionGeneration, reason: 'page' | 'connection'): void {
    if (this.generation !== generation) return;
    if (reason === 'connection' || generation.staleReason === undefined) {
      generation.staleReason = reason === 'connection' ? 'connection' : (generation.staleReason ?? 'page');
    }
    generation.stale = true;
    if (generation.inflight === 0) {
      generation.resolveDrained();
      void this.beginDisposal(generation);
    }
  }

  /** Single-flight disposal of one stale generation; waits for its in-flight reads to exit. */
  private beginDisposal(generation: SessionGeneration): Promise<void> {
    if (generation.disposal) return generation.disposal;
    const disposal = (async () => {
      await generation.drained;
      await bounded(this.disposeGenerationResources(generation), this.closeWaitMs());
    })();
    generation.disposal = disposal;
    this.disposal = disposal;
    void disposal
      .finally(() => {
        if (this.disposal === disposal) this.disposal = undefined;
        this.afterActivity();
      })
      .catch(() => undefined);
    return disposal;
  }

  private async disposeGeneration(generation: SessionGeneration): Promise<void> {
    return this.beginDisposal(generation);
  }

  private async disposeGenerationResources(generation: SessionGeneration): Promise<void> {
    if (this.generation === generation) this.generation = undefined;
    if (this.page === generation.page) this.page = undefined;
    if (generation.staleReason === 'page') {
      // The tab went away but the connection and context are healthy: only the page is rebuilt.
      try {
        await generation.page.close();
      } catch {
        // Already closed.
      }
      return;
    }
    if (this.browser === generation.browser) {
      const browser = this.browser;
      this.browser = undefined;
      try {
        await browser.close();
      } catch {
        // Already gone.
      }
    }
    if (this.context === generation.context) {
      const context = this.context;
      this.context = undefined;
      try {
        await context.close();
      } catch {
        // Already gone.
      }
    }
  }

  // --- page ----------------------------------------------------------------------------------

  /** Single-flight open of a new generation, optionally reusing a healthy connection/context. */
  private async openGeneration(): Promise<SessionGeneration> {
    if (this.closed || this.retired) throw cancelled('The browser session was closed before it could attach.');
    let page: Page | undefined;
    if (this.browser?.isConnected() && this.context) {
      try {
        page = this.context.pages().find(candidate => !candidate.isClosed()) ?? await this.context.newPage();
      } catch {
        await this.resetResources();
      }
    }
    if (this.closed || this.retired) {
      await this.resetResources();
      throw cancelled('The browser session was closed while it was attaching.');
    }
    if (!page) {
      await this.resetResources();
      const browser = await this.connectBrowser();
      if (this.closed || this.retired) {
        this.browser = undefined;
        await browser.close().catch(() => undefined);
        throw cancelled('The browser session was closed while it was attaching.');
      }
      this.browser = browser;
      // Contexts belong to the client that created them, so this process owns the only one it can
      // see; the keeper's context is a different client's and is never touched. A saved session is
      // loaded here, if one exists.
      const saved = this.savedStatePath();
      const context = await browser.newContext({
        locale: 'zh-CN',
        // viewport: null keeps the browser window at its real size instead of emulating one.
        viewport: null,
        ...(saved ? { storageState: saved } : {}),
      });
      if (this.closed || this.retired) {
        // close() won the race while newContext was in flight: close this late context now.
        await bounded((async () => {
          await context.close().catch(() => undefined);
          await this.dropResources();
        })(), this.closeWaitMs());
        throw cancelled('The browser session was closed while it was creating its context.');
      }
      this.context = context;
      page = context.pages().find(candidate => !candidate.isClosed()) ?? await context.newPage();
      if (this.closed || this.retired) {
        await this.resetResources();
        throw cancelled('The browser session was closed while it was creating its page.');
      }
    }
    this.page = page;
    let ready: Page;
    try {
      ready = await this.ensureOnSite(page);
    } catch (error) {
      if (this.closed || this.retired) await this.resetResources();
      throw error;
    }
    if (this.closed || this.retired) {
      await this.resetResources();
      throw cancelled('The browser session was closed while it was attaching.');
    }
    const browser = this.browser;
    const context = this.context;
    if (!browser || !context) {
      await this.resetResources();
      throw new SearchError('protocol', 'The browser session lost its resources while attaching.');
    }
    const generation = createGeneration(browser, context, ready);
    this.generation = generation;
    return generation;
  }

  private async connectBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    await this.resetResources();
    try {
      const browser = await (this.options.connect ?? defaultConnect)(this.options);
      if (this.closed || this.retired) {
        await browser.close().catch(() => undefined);
        throw cancelled('The browser session was closed while it was attaching.');
      }
      this.browser = browser;
      return browser;
    } catch (error) {
      if (error instanceof SearchError) throw error;
      throw connectFailure(error, this.options);
    }
  }

  private async ensureOnSite(page: Page): Promise<Page> {
    if (sameSite(page.url(), this.options.siteUrl)) return page;
    if (this.closed) throw cancelled('The browser session was closed while it was opening the site.');
    try {
      await page.goto(this.options.siteUrl, { waitUntil: 'domcontentloaded', timeout: this.options.timeoutMs });
    } catch (error) {
      if (this.closed) throw cancelled('The browser session was closed while it was opening the site.');
      throw new SearchError('network', `Could not open ${this.options.siteUrl} in the browser: ${message(error)}`);
    }
    // No bringToFront here: the page window belongs to whoever signs in over VNC, and a read must
    // not pull focus away from it.
    return page;
  }

  /** Bounded reset used by open/close paths so a wedged teardown cannot block a read forever. */
  private async resetResources(): Promise<void> {
    await bounded(this.dropResources(), this.closeWaitMs());
  }

  private async dropResources(): Promise<void> {
    const browser = this.browser;
    const context = this.context;
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    // Drop the connection first: it must not depend on a page or context closing gracefully.
    try {
      await browser?.close();
    } catch {
      // Already gone.
    }
    try {
      await context?.close();
    } catch {
      // Already gone.
    }
  }

  private savedStatePath(): string | undefined {
    const statePath = this.options.statePath;
    return statePath && existsSync(statePath) ? statePath : undefined;
  }

  // --- reader ---------------------------------------------------------------------------------

  private readerFor(job: ReadJob, lease: Lease): BrowserReader {
    return {
      evaluate: async <T>(script: string): Promise<T> => {
        const stop = (): never => {
          throw cancelled('The browser read was cancelled before the next page operation started.');
        };
        if (this.closed || this.retired) throw cancelled('The browser session was closed.');
        if (job.signal?.aborted || job.cancelRequested) stop();
        const page = lease.generation.page;
        if (page.isClosed()) {
          this.markGenerationStale(lease.generation, 'page');
          throw new SearchError('protocol', `The ${siteName(this.options.siteUrl)} page was closed before the read started.`);
        }
        try {
          // Playwright treats a string argument as an expression and never calls it, so the
          // generated source becomes a function here and is serialised like any page function.
          const pageFunction = new Function(`return (${script});`)() as () => Promise<T>;
          // The site's own client lives in the main world, so this call opts out of patchright's
          // isolated-context default; isolation would hide the very runtime we need to reach.
          return await page.evaluate(pageFunction, undefined, {}, false) as T;
        } catch (error) {
          if (this.closed || this.retired) throw cancelled('The browser session was closed during the read.');
          if (!lease.generation.browser.isConnected()) this.markGenerationStale(lease.generation, 'connection');
          else if (page.isClosed()) this.markGenerationStale(lease.generation, 'page');
          throw new SearchError('protocol', `The ${siteName(this.options.siteUrl)} page refused to run the read: ${message(error)}`);
        }
      },
      invalidate: () => {
        this.markGenerationStale(lease.generation, 'connection');
      },
    };
  }

  // --- persist -------------------------------------------------------------------------------

  private async persistUnlocked(): Promise<void> {
    if (this.options.statePolicy === 'read-only') return;
    const statePath = this.options.statePath;
    const context = this.context;
    if (!statePath || !context) return;
    if (Date.now() - this.savedAt < PERSIST_INTERVAL_MS) return;
    try {
      await context.storageState({ path: statePath });
      // Only a completed save moves the clock, so a failed save is retried next time.
      this.savedAt = Date.now();
    } catch {
      // A failed save must not fail a read or a close; the next call tries again.
    }
  }

  private runMaintenance(fn: () => Promise<void>): Promise<void> {
    if (this.maintenance) return this.maintenance;
    const task = (async () => {
      if (this.closed || this.retired) return;
      this.maintenanceRequested = true;
      this.clearIdleTimer();
      try {
        await abortable(
          new Promise<void>(resolve => {
            if (this.activeCount === 0) resolve();
            else this.zeroWaiters.push(resolve);
          }),
          this.shutdown.signal,
        );
        if (this.closed || this.retired) return;
        this.maintenanceRequested = false;
        this.maintenanceRunning = true;
        try {
          await fn();
        } finally {
          this.maintenanceRunning = false;
        }
      } finally {
        this.maintenanceRequested = false;
        this.maintenanceRunning = false;
        this.pump();
        this.afterActivity();
      }
    })();
    this.maintenance = task;
    void task
      .finally(() => {
        if (this.maintenance === task) this.maintenance = undefined;
      })
      .catch(() => undefined);
    return task;
  }

  // --- idle ----------------------------------------------------------------------------------

  private scheduleIdle(): void {
    this.clearIdleTimer();
    if (!this.canIdle()) return;
    const idleMs = this.options.idleTimeoutMs ?? DEFAULT_IDLE_MS;
    if (idleMs <= 0) return;
    const timer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.runIdle();
    }, idleMs);
    timer.unref?.();
    this.idleTimer = timer;
  }

  private canIdle(): boolean {
    return (
      !this.closed &&
      !this.retired &&
      !this.idleDisposed &&
      !this.idleRunning &&
      !this.opening &&
      !this.disposal &&
      !this.maintenanceRequested &&
      !this.maintenanceRunning &&
      this.activeCount === 0 &&
      this.waiters.length === 0
    );
  }

  private async runIdle(): Promise<void> {
    if (!this.canIdle()) return;
    this.idleRunning = true;
    this.clearIdleTimer();
    try {
      this.generation = undefined;
      this.page = undefined;
      await bounded(this.dropResources(), this.closeWaitMs());
      if (this.closed || this.retired) return;
      if (this.waiters.length > 0) {
        // A read arrived while the teardown was running. Keep this instance and let it reattach.
        this.idleDisposed = false;
        return;
      }
      if (this.onDisposed) {
        // A registered instance is retired with its map entry; a stale reference must not reattach
        // and race the fresh instance the registry will hand out.
        this.retired = true;
        try {
          this.onDisposed();
        } catch {
          // The registry callback is best effort.
        }
        return;
      }
      this.idleDisposed = true;
    } finally {
      this.idleRunning = false;
      this.pump();
      this.afterActivity();
    }
  }

  private afterActivity(): void {
    if (this.activeCount === 0) this.resolveZeroWaiters();
    if (this.canIdle()) this.scheduleIdle();
    else this.clearIdleTimer();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  // --- shutdown ------------------------------------------------------------------------------

  private closeWaitMs(): number {
    return this.options.closeTimeoutMs ?? DEFAULT_CLOSE_MS;
  }

  private cancelWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const job of waiters) {
      job.cancelled = true;
      job.reject(cancelled('The browser session was closed.'));
    }
  }

  private resolveZeroWaiters(): void {
    if (this.activeCount !== 0 || this.zeroWaiters.length === 0) return;
    const waiters = this.zeroWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private async waitForActiveZero(timeoutMs: number): Promise<boolean> {
    if (this.activeCount === 0) return true;
    if (timeoutMs <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const zero = new Promise<boolean>(resolve => {
      this.zeroWaiters.push(() => resolve(true));
    });
    const result = await Promise.race([zero, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  }

  private async disposeAfterClose(): Promise<void> {
    // One deadline for the whole shutdown: waiting for reads, the best-effort save and the forced
    // teardown all spend from the same budget. A slice is reserved for the teardown, so a read that
    // uses the whole wait still cannot leave the connection undropped.
    const total = Math.max(0, this.closeWaitMs());
    const deadline = Date.now() + total;
    const teardownReserve = Math.min(1_000, Math.max(1, Math.floor(total / 4)));
    const finished = await this.waitForActiveZero(Math.max(0, deadline - Date.now() - teardownReserve));
    if (!finished) {
      // The grace window expired. Mark every in-flight read as cancelled so the failure the forced
      // close causes is reported as `cancelled`, not as a protocol error; a read that finished
      // inside the window kept its own result.
      for (const job of this.activeJobs) job.cancelRequested = true;
    } else if (!this.maintenanceRunning && !this.maintenanceRequested) {
      const persistBudget = Math.max(0, deadline - Date.now() - teardownReserve);
      if (persistBudget > 0) await bounded(this.persistUnlocked(), persistBudget);
    }
    this.generation = undefined;
    this.page = undefined;
    // A wedged browser can also make the teardown hang; report completion after the budget and let
    // it finish in the background. Nothing can use this session any more.
    await bounded(this.dropResources(), Math.max(1, deadline - Date.now()));
    // Settle internal zero-wait promises even if a stuck transaction never reached zero; their
    // callers are already closed and this only prevents retained callbacks.
    const zeroWaiters = this.zeroWaiters.splice(0);
    for (const resolve of zeroWaiters) resolve();
    try {
      this.onDisposed?.();
    } catch {
      // The registry callback is best effort.
    }
  }
}

/** A refused endpoint, a missing one and a version mismatch each need a different fix. */
export function connectFailure(error: unknown, options: BrowserSessionOptions): SearchError {
  const text = message(error);
  if (/version mismatch/i.test(text) || /\b428\b/.test(text)) {
    return new SearchError('protocol', `The Playwright server and this client disagree on protocol version, so no request was sent. Update whichever side is older; both must share the same major.minor. (${text.slice(0, 200)})`);
  }
  if (/\b401\b|unauthori[sz]ed/i.test(text)) {
    return new SearchError('authentication', `The Playwright endpoint at ${options.wsEndpoint} rejected the token. Check the token the server printed at startup.`);
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/i.test(text)) {
    return new SearchError('network', `No Playwright server answered at ${options.wsEndpoint}. Start the browser container, or fix the endpoint address.`);
  }
  return new SearchError('network', `Could not attach to the Playwright endpoint at ${options.wsEndpoint}: ${text.slice(0, 200)}`);
}

/** Sessions are shared by endpoint: one connection, many readers, one page per site. */
const sessions = new Map<string, BrowserSession>();

/** The session for an endpoint, created on first use and reused until it closes or idles out. */
export function sessionFor(key: string, options: BrowserSessionOptions): BrowserSession {
  const existing = sessions.get(key);
  if (existing && !existing.isClosed) return existing;
  let created: BrowserSession;
  created = new BrowserSession(options, () => {
    // Idle release and an explicit close both free the map entry; the next caller gets a new
    // session that reattaches on demand instead of the map growing with dead entries.
    if (sessions.get(key) === created) sessions.delete(key);
  });
  sessions.set(key, created);
  return created;
}

/** Close every kept session; the host calls this when it shuts down. */
export async function closeBrowserSessions(): Promise<void> {
  // Truncate synchronously so a sessionFor() racing the shutdown starts a fresh session instead
  // of joining one that is being disposed.
  const open = [...sessions.values()];
  sessions.clear();
  await Promise.all(open.map(session => session.close().catch(() => undefined)));
}
