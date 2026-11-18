import { backendById } from '../catalog.js';
import { backendCredentialRef, browserCredentialRef } from '../config.js';
import type { SearchConfig } from '../types.js';
import { htmlToMarkdown } from './html.js';
import { fetchOverHttp, type HttpTransportFactory } from './http.js';
import { fetchWithBrowser, type BrowserFetcher } from './browser-route.js';
import { callProviderTool, fetchFromProvider, type ProviderCall } from './provider.js';
import { evaluateRules, type RuleInputs } from './rules.js';
import { assertLiteralTargetPolicy, FetchPolicyError, parseTargetUrl, systemResolver, type AddressResolver } from './safety.js';
import {
  MAX_CONVERSION_INPUT_CHARS,
  MAX_FETCH_BODY_BYTES,
  MAX_FETCH_OVERALL_TIMEOUT_MS,
  MAX_FETCH_OUTPUT_CHARS,
  MAX_FETCH_REDIRECTS,
  MAX_RULE_SCAN_CHARS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_RULE_SCAN_CHARS,
} from './limits.js';
import { planContent, type RouteResult } from './acquisition.js';
import {
  PageFetchError,
  type FetchAttempt,
  type FetchFailureKind,
  type FetchFormat,
  type FetchOutcomeKind,
  type FetchRouteKind,
  type FetchStopReason,
  type PageFetchInput,
  type PageFetchResult,
} from './types.js';

/**
 * The page-fetch engine: one URL in, one bounded page out.
 *
 * Routes run one at a time in configured order and never in parallel. Every outcome is evaluated
 * against that route's fallback rules; a match continues, no match stops. Cancellation, the overall
 * deadline, target policy, invalid global configuration and acquisition limits are fatal and never
 * become a fallback.
 */
export interface PageFetchDependencies {
  /** Resolves the fixed credential names the configuration uses; hosts supply their own store. */
  resolveCredential?: (ref: string) => Promise<string | undefined>;
  fetcher?: typeof fetch;
  /** A transport that owns its own connection policy; the default pins the validated address. */
  transportFactory?: HttpTransportFactory;
  resolver?: AddressResolver;
  /** Injected browser transport; production attaches to the configured Playwright server. */
  browser?: BrowserFetcher;
  /** Injected MCP caller; production uses the official client. */
  providerCall?: ProviderCall;
  /** Test/embedding seam for the provider's HTTP exchange; production leaves it out. */
  providerFetcher?: typeof fetch;
}

interface ProviderSetup {
  id: string;
  tool: string;
  endpoint: string;
  mode: string;
  options: Record<string, string | number | boolean>;
  timeoutMs: number;
}

const lossless = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(item => lossless(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      output[key] = lossless(item);
    }
    return output as unknown as T;
  }
  return value;
};

const failureKindFor = (outcome: FetchOutcomeKind): FetchFailureKind | undefined => {
  switch (outcome) {
    case 'network':
      return 'network';
    case 'timeout':
      return 'timeout';
    case 'http-error':
      return 'http';
    case 'provider-error':
      return 'provider';
    case 'authentication':
      return 'authentication';
    case 'protocol':
      return 'protocol';
    case 'conversion-error':
      return 'conversion';
    case 'unsupported-content':
      return 'unsupported-content';
    case 'limit':
      return 'limit';
    default:
      return undefined;
  }
};

export class PageFetchEngine {
  constructor(private config: SearchConfig, private dependencies: PageFetchDependencies = {}) {}

  /** Fetch one URL. `format` is required: there is no saved default and no implicit fallback. */
  async fetchPage(input: PageFetchInput, signal?: AbortSignal): Promise<PageFetchResult> {
    const format = input?.format;
    if (format !== 'html' && format !== 'markdown') {
      throw new PageFetchError('invalid-input', 'format is required: use "markdown" for reading or "html" to inspect the page structure.');
    }
    const requestedUrl = input?.url;
    const target = parseTargetUrl(requestedUrl);
    const settings = this.config.pageFetch;
    if (!settings || !Array.isArray(settings.routes)) throw new PageFetchError('configuration', 'The page-fetch configuration is missing.');
    const routes = settings.routes.filter(route => route.enabled);
    if (!routes.length) throw new PageFetchError('configuration', 'Every page-fetch route is disabled, so no fetch can run.');
    for (const route of routes) {
      if ((route.kind === 'browser' || route.kind === 'provider') && !settings.allowDelegatedFetching) {
        throw new PageFetchError(
          'configuration',
          'A browser or provider route is enabled without allowDelegatedFetching. Those routes resolve the target outside this process, so the public-only policy cannot be proven; enable the delegated opt-in deliberately.',
        );
      }
    }
    const provider = routes.some(route => route.kind === 'provider') ? this.providerSetup() : undefined;
    const browserEndpoint = routes.some(route => route.kind === 'browser') ? this.browserEndpoint() : undefined;

    const maxBodyBytes = clamp(settings.maxBodyBytes, MAX_FETCH_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
    const maxOutputChars = clamp(settings.maxOutputChars, MAX_FETCH_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS);
    const maxRuleScanChars = clamp(settings.maxRuleScanChars, MAX_RULE_SCAN_CHARS, DEFAULT_MAX_RULE_SCAN_CHARS);
    const maxRedirects = clamp(settings.maxRedirects, MAX_FETCH_REDIRECTS, DEFAULT_MAX_REDIRECTS);
    const overallTimeoutMs = clamp(settings.overallTimeoutMs, MAX_FETCH_OVERALL_TIMEOUT_MS, 90_000);

    const caller = signal ?? new AbortController().signal;
    const deadline = AbortSignal.timeout(overallTimeoutMs);
    const combined = AbortSignal.any([caller, deadline]);
    const fatalReason = (): Extract<FetchStopReason, 'cancelled' | 'deadline'> | undefined =>
      caller.aborted ? 'cancelled' : deadline.aborted ? 'deadline' : undefined;
    const resolver = this.dependencies.resolver ?? systemResolver;
    const attempts: FetchAttempt[] = [];
    const notes: string[] = [];
    const base: Pick<PageFetchResult, 'requestedUrl' | 'format'> = { requestedUrl: target.href, format };
    const finish = (
      stopReason: FetchStopReason,
      extra: Partial<Omit<PageFetchResult, 'requestedUrl' | 'format' | 'attempts' | 'notes' | 'stopReason' | 'ok' | 'truncated'>> & { ok: boolean; truncated?: boolean },
    ): PageFetchResult =>
      lossless({
        ...base,
        ...extra,
        ok: extra.ok,
        stopReason,
        truncated: extra.truncated ?? false,
        attempts,
        notes,
      }) as PageFetchResult;

    // Literal hosts are refused before any route runs; name resolution is checked per HTTP hop.
    try {
      assertLiteralTargetPolicy(target, settings.allowPrivateNetworks);
    } catch (error) {
      if (error instanceof FetchPolicyError) {
        notes.push('The target URL was refused by the target policy before any route ran.');
        return finish('policy', { ok: false });
      }
      throw error;
    }

    let preserved: { result: RouteResult; route: FetchRouteKind; providerId?: string; content: string; representation?: RouteResult['representation'] } | undefined;

    for (const route of routes) {
      const early = fatalReason();
      if (early) {
        notes.push(early === 'deadline' ? 'The overall deadline ended execution before this route ran.' : 'The caller cancelled execution before this route ran.');
        return finish(early, { ok: false });
      }

      // Format compatibility is decided before a request is spent: a Markdown-only provider cannot
      // serve HTML, and that is a capability skip, not a failure and not a switch to another provider.
      if (route.kind === 'provider' && provider && !providerServes(provider.id, format)) {
        attempts.push({
          route: 'provider',
          provider: provider.id,
          durationMs: 0,
          outcome: 'unsupported-format',
          rules: [],
          unavailable: [`markdown: ${provider.id} returns native Markdown only and cannot produce page HTML`],
        });
        notes.push(`The selected provider cannot produce ${format}; its request was skipped without being sent.`);
        continue;
      }

      const routeSignal = AbortSignal.any([combined, AbortSignal.timeout(route.timeoutMs)]);
      const started = Date.now();
      let result: RouteResult;
      try {
        result = await this.runRoute(route, {
          format,
          target,
          routeSignal,
          maxBodyBytes,
          maxRedirects,
          allowPrivateNetworks: settings.allowPrivateNetworks,
          resolver,
          provider,
          browserEndpoint,
          settings,
        });
      } catch (error) {
        const fatal = fatalReason();
        if (fatal) result = routeResultForFatal(fatal);
        else if (routeSignal.aborted) result = { outcome: 'timeout', error: { kind: 'timeout', message: 'The route did not finish within its own timeout.' }, notes: [] };
        else if (error instanceof FetchPolicyError) result = { outcome: 'policy', fatal: true, error: { kind: 'policy', message: error.message }, notes: [] };
        else if (error instanceof TypeError) result = { outcome: 'network', error: { kind: 'network', message: 'The request failed before a response arrived; check connectivity.' }, notes: [] };
        else result = { outcome: 'protocol', error: { kind: 'protocol', message: 'The route failed unexpectedly.' }, notes: [] };
      }
      const durationMs = Date.now() - started;

      // A per-route timeout that arrives while the caller is still waiting is a route failure a
      // fallback rule may act on; a caller abort or the overall deadline is fatal instead.
      if (result.outcome === 'cancelled' && !fatalReason() && routeSignal.aborted) {
        result = { ...result, outcome: 'timeout', fatal: false, error: { kind: 'timeout', message: 'The route did not finish within its own timeout.' } };
      }

      // Convert accepted or acquired content before rules look at the outcome, so a conversion
      // failure is a typed operational error a rule can match instead of an invented success.
      const plan = result.html !== undefined || result.markdown !== undefined || result.text !== undefined
        ? planContent(result, { format, maxConversionChars: Math.min(MAX_CONVERSION_INPUT_CHARS, maxRuleScanChars * 4), convert: htmlToMarkdown })
        : undefined;
      if (result.outcome === 'ok' && plan?.failure) {
        result = { ...result, outcome: plan.failure.outcome, error: { kind: plan.failure.error.kind, message: plan.failure.error.message } };
      }
      if (plan?.truncatedByConversionInput) notes.push('The page was large, so conversion read a bounded prefix of the HTML.');

      const scanNotes: string[] = [];
      // A Markdown condition on an HTTP or browser route reads the converted projection, because that
      // is the Markdown this call would actually return. Native provider Markdown is never reconverted,
      // and with format=html there is no Markdown to read, so the field stays unavailable.
      const convertedMarkdown = format === 'markdown' ? plan?.content : undefined;
      const ruleInputs = buildRuleInputs(result, maxRuleScanChars, scanNotes, convertedMarkdown);
      const evaluation = evaluateRules(route.rules, ruleInputs);
      const attempt: FetchAttempt = lossless({
        route: route.kind,
        ...(route.kind === 'provider' && provider ? { provider: provider.id } : {}),
        durationMs,
        outcome: result.outcome,
        ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
        ...(result.apiStatus === undefined ? {} : { apiStatus: result.apiStatus }),
        ...(result.representation === undefined ? {} : { representation: result.representation }),
        rules: evaluation.ruleIds,
        unavailable: [...evaluation.unavailable, ...scanNotes],
        ...(result.error === undefined ? {} : { error: { kind: result.error.kind, message: result.error.message, ...(result.error.status === undefined ? {} : { status: result.error.status }) } }),
      }) as FetchAttempt;
      attempts.push(attempt);
      notes.push(...result.notes);

      const fatal = fatalReason();
      if (fatal) return finish(fatal, { ok: false });
      if (result.fatal) {
        const stopReason: FetchStopReason = result.outcome === 'policy' ? 'policy' : result.outcome === 'limit' ? 'limit' : 'stopped-on-error';
        return finish(stopReason, { ok: false, ...(result.finalUrl ? { finalUrl: result.finalUrl } : {}) });
      }

      if (result.outcome === 'ok' && !evaluation.matched) {
        const raw = plan?.content ?? '';
        if (!raw) return finish('stopped-on-error', { ok: false, ...(result.finalUrl ? { finalUrl: result.finalUrl } : {}) });
        const truncated = raw.length > maxOutputChars;
        if (truncated) notes.push(`The content was truncated to the ${maxOutputChars}-character output limit; this is not an acquisition failure.`);
        return finish('accepted', {
          ok: true,
          content: truncated ? raw.slice(0, maxOutputChars) : raw,
          contentRoute: route.kind,
          ...(route.kind === 'provider' && provider ? { contentProvider: provider.id } : {}),
          ...(result.representation ? { representation: result.representation } : {}),
          ...(result.finalUrl ? { finalUrl: result.finalUrl } : {}),
          ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
          truncated,
        });
      }

      if (evaluation.matched) {
        // Keep the last acquired page once, so an exhausted chain can still show what it got.
        const raw = plan?.content;
        if (raw) {
          preserved = {
            result,
            route: route.kind,
            ...(route.kind === 'provider' && provider ? { providerId: provider.id } : {}),
            content: raw,
            ...(result.representation ? { representation: result.representation } : {}),
          };
        }
        notes.push(`Fallback rule(s) ${evaluation.ruleIds.join(', ')} matched on the ${route.kind} route; continuing to the next enabled route.`);
        continue;
      }

      // A failure with no matching rule stops the chain. The bounded body is still diagnostic content.
      const raw = plan?.content ?? '';
      const truncated = raw.length > maxOutputChars;
      if (raw) notes.push('The fetch stopped on this error; the acquired body is included once as diagnostic content.');
      return finish('stopped-on-error', {
        ok: false,
        ...(raw ? { content: truncated ? raw.slice(0, maxOutputChars) : raw, contentRoute: route.kind } : {}),
        ...(route.kind === 'provider' && provider ? { contentProvider: provider.id } : {}),
        ...(result.representation ? { representation: result.representation } : {}),
        ...(result.finalUrl ? { finalUrl: result.finalUrl } : {}),
        ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
        truncated,
      });
    }

    if (preserved) {
      const truncated = preserved.content.length > maxOutputChars;
      notes.push(`Every enabled route was used without an accepted page. The page acquired by the ${preserved.route} route is included once as diagnostic content.`);
      return finish('exhausted', {
        ok: false,
        content: truncated ? preserved.content.slice(0, maxOutputChars) : preserved.content,
        contentRoute: preserved.route,
        ...(preserved.providerId ? { contentProvider: preserved.providerId } : {}),
        ...(preserved.representation ? { representation: preserved.representation } : {}),
        ...(preserved.result.finalUrl ? { finalUrl: preserved.result.finalUrl } : {}),
        ...(preserved.result.statusCode === undefined ? {} : { statusCode: preserved.result.statusCode }),
        truncated,
      });
    }
    notes.push('Every enabled route was skipped or failed and no page was acquired.');
    return finish('exhausted', { ok: false });
  }

  private browserEndpoint(): string {
    const endpoint = this.config.browser?.endpoint ?? '';
    if (!endpoint) throw new PageFetchError('configuration', 'The browser route is enabled but no shared browser endpoint is configured.');
    return endpoint;
  }

  private providerSetup(): ProviderSetup {
    const settings = this.config.pageFetch;
    const id = settings.providerId;
    if (!id) throw new PageFetchError('configuration', 'The provider route is enabled but no fetch-capable provider is selected.');
    const definition = backendById(id);
    const operation = definition?.fetch;
    const saved = this.config.backends[id];
    if (!definition || !operation || !saved) throw new PageFetchError('configuration', `"${id}" is not a fetch-capable provider in this release.`);
    const fetchConfig = saved.fetch;
    if (!fetchConfig) throw new PageFetchError('configuration', `The fetch settings for "${id}" are missing.`);
    if (!operation.modes.includes(fetchConfig.mode)) {
      throw new PageFetchError('configuration', `"${id}" does not support the ${fetchConfig.mode} access mode for fetching.`);
    }
    const endpoint = fetchConfig.endpoint || definition.modes.find(mode => mode.mode === fetchConfig.mode)?.fetchEndpoint || '';
    if (!endpoint) throw new PageFetchError('configuration', `"${id}" has no fetch endpoint configured.`);
    if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
      throw new PageFetchError('configuration', `The fetch endpoint for "${id}" must be an HTTP(S) MCP endpoint.`);
    }
    return { id, tool: operation.tool, endpoint, mode: fetchConfig.mode, options: fetchConfig.options, timeoutMs: fetchConfig.timeoutMs };
  }

  private async runRoute(
    route: SearchConfig['pageFetch']['routes'][number],
    context: {
      format: FetchFormat;
      target: URL;
      routeSignal: AbortSignal;
      maxBodyBytes: number;
      maxRedirects: number;
      allowPrivateNetworks: boolean;
      resolver: AddressResolver;
      provider: ProviderSetup | undefined;
      browserEndpoint: string | undefined;
      settings: SearchConfig['pageFetch'];
    },
  ): Promise<RouteResult> {
    const { target, routeSignal, format } = context;
    if (route.kind === 'http') {
      return fetchOverHttp({
        url: target,
        format,
        routeTimeoutMs: route.timeoutMs,
        maxRedirects: context.maxRedirects,
        maxBodyBytes: context.maxBodyBytes,
        allowPrivateNetworks: context.allowPrivateNetworks,
        signal: routeSignal,
        ...(this.dependencies.fetcher ? { fetcher: this.dependencies.fetcher } : {}),
        ...(this.dependencies.transportFactory ? { transportFactory: this.dependencies.transportFactory } : {}),
        resolver: context.resolver,
      });
    }
    if (route.kind === 'browser') {
      const token = await this.resolve(browserCredentialRef());
      const fetch = this.dependencies.browser ?? fetchWithBrowser;
      return fetch({
        url: target,
        format,
        routeTimeoutMs: route.timeoutMs,
        settleMs: context.settings.browser.settleMs,
        selectorWait: context.settings.browser.selectorWait,
        contextMode: context.settings.browser.context,
        endpoint: context.browserEndpoint!,
        ...(token ? { token } : {}),
        ...(this.config.browser.statePath ? { statePath: this.config.browser.statePath } : {}),
        signal: routeSignal,
        maxBodyBytes: context.maxBodyBytes,
      });
    }
    const provider = context.provider!;
    const credential = provider.mode === 'anonymous' ? undefined : await this.resolve(backendCredentialRef(provider.id));
    if (provider.mode !== 'anonymous' && !credential) {
      return {
        outcome: 'authentication',
        error: { kind: 'authentication', message: 'The provider credential is missing for the configured access mode.' },
        notes: [],
      };
    }
    const fetch = this.dependencies.providerCall;
    const request = {
      providerId: provider.id,
      url: target.href,
      format,
      endpoint: provider.endpoint,
      tool: provider.tool,
      options: provider.options,
      routeTimeoutMs: Math.min(route.timeoutMs, provider.timeoutMs),
      signal: routeSignal,
      maxChars: context.maxBodyBytes,
      ...(credential ? { credential } : {}),
      ...(this.dependencies.providerFetcher ? { fetcher: this.dependencies.providerFetcher } : {}),
    };
    return fetchFromProvider(request, fetch ?? callProviderTool);
  }

  private async resolve(ref: string): Promise<string | undefined> {
    if (!this.dependencies.resolveCredential) return undefined;
    try {
      return await this.dependencies.resolveCredential(ref);
    } catch {
      return undefined;
    }
  }
}

const clamp = (value: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 1), max) : fallback;

const providerServes = (providerId: string, format: FetchFormat): boolean => {
  const operation = backendById(providerId)?.fetch;
  return !!operation && operation.serves.includes(format);
};

const routeResultForFatal = (reason: 'cancelled' | 'deadline'): RouteResult => ({
  outcome: 'cancelled',
  fatal: true,
  error: { kind: 'network', message: reason === 'deadline' ? 'The overall deadline ended this route.' : 'The caller cancelled this route.' },
  notes: [],
});

/** Build the fallback-rule view of one outcome, truncating each field at the rule scan bound. */
function buildRuleInputs(result: RouteResult, maxScanChars: number, scanNotes: string[], convertedMarkdown?: string): RuleInputs {
  const fields: RuleInputs['fields'] = {};
  const take = (field: 'title' | 'html' | 'text' | 'markdown', value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    if (value.length <= maxScanChars) return value;
    scanNotes.push(`${field}: the rule scan stopped at ${maxScanChars} characters`);
    return value.slice(0, maxScanChars);
  };
  const title = take('title', result.title);
  const html = take('html', result.html);
  const text = take('text', result.text);
  const markdown = take('markdown', result.markdown ?? convertedMarkdown);
  if (title !== undefined) fields.title = title;
  if (html !== undefined) fields.html = html;
  if (text !== undefined) fields.text = text;
  if (markdown !== undefined) fields.markdown = markdown;
  return {
    ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
    ...(result.apiStatus === undefined ? {} : { apiStatus: result.apiStatus }),
    networkFailed: result.outcome === 'network',
    timedOut: result.outcome === 'timeout',
    ...(failureKindFor(result.outcome) ? { failure: failureKindFor(result.outcome)! } : {}),
    fields,
  };
}

/** Convenience factory so a host only supplies a credential resolver. */
export function createPageFetchEngine(config: SearchConfig, dependencies: PageFetchDependencies = {}): PageFetchEngine {
  return new PageFetchEngine(config, dependencies);
}
