import type { FetchBackendConfig, FetchOperationDefinition, PageFetchConfig } from './fetch/types.js';

export type AccessMode = 'anonymous' | 'key' | 'oauth' | 'session' | 'browser';
export type CostTier = 'free' | 'allowance' | 'trial' | 'paid' | 'self-hosted' | 'account' | 'unverified';
export type Localized = { en: string; zh: string };
export interface OptionField {
  key: string; type: 'string' | 'number' | 'boolean' | 'select'; label: Localized; help: Localized;
  default: string | number | boolean; choices?: string[]; min?: number; max?: number;
}
export interface ModeDefinition {
  mode: AccessMode; endpoint: string; tier: CostTier; limits: Localized; pricingUrl: string;
  /** What the credential field expects, shown next to it; absent means no credential is used. */
  credentialShape?: Localized;
  /**
   * Endpoint of the fetch operation in this access mode, when it differs from the search endpoint.
   * Absent means this mode has no verified fetch endpoint, so it cannot be selected for fetching.
   */
  fetchEndpoint?: string;
}
export interface BackendDefinition {
  id: string; title: string; status: 'documented' | 'unverified'; docs: string; verifiedAt: string;
  /** 'live' means this deployment completed a real call to the backend, not merely that docs describe it. */
  evidence: 'documented' | 'live';
  modes: ModeDefinition[]; options: OptionField[]; capabilities: string[];
  /**
   * The typed fetch operation, when the provider contract supports one. Metadata, not a user toggle:
   * a search-only provider has no such entry and can never be selected for a page fetch.
   */
  fetch?: FetchOperationDefinition;
}
export interface RetryConfig {
  enabled: boolean; statuses: number[]; maxRetries: number; initialDelayMs: number; maxDelayMs: number;
  networkErrors: boolean; timeouts: boolean;
}
export interface BackendConfig {
  enabled: boolean; mode: AccessMode; endpoint: string; timeoutMs: number;
  rateLimitPerMinute: number; dailyAttemptLimit: number; options: Record<string, string | number | boolean>;
  /**
   * Operation-specific fetch settings. Sharing a provider does not mean sharing an endpoint, access
   * mode, timeout or options: fetching often uses a different endpoint than searching.
   */
  fetch: FetchBackendConfig;
}
export interface SearchConfig {
  maxResults: number; concurrency: number;
  overallTimeoutMs: number; language: string; region: string; recency: 'any' | 'day' | 'week' | 'month' | 'year';
  safeSearch: boolean; includeDomains: string[]; excludeDomains: string[]; dedup: 'url' | 'url-title';
  fusion: 'rrf' | 'ordered'; retry: RetryConfig;
  /** Shared by every browser-backed reader; credentials use the fixed browser token name. */
  browser: BrowserConfig;
  cache: { enabled: boolean; ttlSeconds: number; maxEntries: number };
  breaker: { enabled: boolean; threshold: number; cooldownMs: number };
  diagnostics: { enabled: boolean; maxEntries: number };
  /** Agent-facing switches; turning one off removes that tool instead of letting the agent ask for it. */
  tools: { webSearchPlus: boolean; compactByDefault: boolean; webExtract: boolean };
  backends: Record<string, BackendConfig>;
  /** Page fetching: ordered routes, fallback rules and the bounds every route shares. */
  pageFetch: PageFetchConfig;
}
/**
 * One browser, shared by every backend that reads through one. A backend that set its own endpoint
 * keeps working: the shared endpoint wins only when it is filled in.
 */
export interface BrowserConfig {
  endpoint: string;
  statePath: string;
  timeoutMs: number;
  /**
   * How many reads may be in flight on one site at once. A local safety bound, not a site quota;
   * integer from 1 through 8. Hosts expose it as a per-site setting.
   */
  maxConcurrentReads: number;
  /**
   * How many search tabs are retained for follow-up note reads. Independent of the active-read
   * limit; integer from 1 through 8, default 4.
   */
  maxPooledTabs: number;
}

/** Adapters omit backends; the engine stamps and unions trusted backend ids on merged results. */
export interface Source { url: string; title?: string; snippet?: string; summary?: string; publishedAt?: string; backends?: string[] }
export interface SearchInput { query: string; maxResults?: number }
/**
 * Per-call strategy; it never mutates saved configuration. There is no mode here: the length of
 * `backends` is the strategy. One id runs that one backend, several run in parallel, and leaving the
 * selection out runs every enabled backend.
 */
export interface SearchOverrides { backends?: string[] | 'all'; exclude?: string[]; maxResults?: number; compact?: boolean }
export interface AdapterInput {
  query: string; maxResults: number; config: SearchConfig; backend: BackendConfig; key?: string; signal: AbortSignal;
}
export interface AdapterResult { sources: Source[]; content?: string; warnings?: string[] }
export type FailureKind = 'configuration' | 'authentication' | 'quota' | 'rate-limit' | 'http' | 'network' | 'timeout' | 'cancelled' | 'protocol' | 'budget' | 'circuit-open' | 'unverified' | 'limit';
export interface BackendOutcome {
  backend: string; mode: AccessMode; ok: boolean; attempts: number; durationMs: number;
  sources: Source[]; warnings: string[]; error?: { kind: FailureKind; message: string; status?: number }; at?: number;
}
export interface SearchResult {
  sources: Source[]; content: string; truncated: boolean; outcomes: BackendOutcome[]; cached: boolean;
}
/** Stable parameters a settings page can interpolate into a localized issue sentence. */
export type ConfigIssueParams = Record<string, string | number>;
/**
 * Where a settings page should take the user when the issue is clicked. `target` is a configuration
 * path or section id; it is deliberately a path rather than a tab name so the library stays free of
 * host navigation. Absent means the issue's own `path` is the target.
 */
export interface ConfigIssueAction { target?: string }
/**
 * One rejected value. `path` and `message` are the original contract and stay complete on their own:
 * a host that knows nothing about codes still gets a readable English sentence per issue. `code` and
 * `params` are the stable, translatable layer, and `action` names the control to reveal.
 */
export interface ConfigIssue {
  path: string;
  message: string;
  code?: string;
  params?: ConfigIssueParams;
  action?: ConfigIssueAction;
}
