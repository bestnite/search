export type AccessMode = 'anonymous' | 'key' | 'oauth' | 'session';
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
}
export interface BackendDefinition {
  id: string; title: string; status: 'documented' | 'unverified'; docs: string; verifiedAt: string;
  /** 'live' means this deployment completed a real call to the backend, not merely that docs describe it. */
  evidence: 'documented' | 'live';
  modes: ModeDefinition[]; options: OptionField[]; capabilities: string[];
}
export interface RetryConfig {
  enabled: boolean; statuses: number[]; maxRetries: number; initialDelayMs: number; maxDelayMs: number;
  networkErrors: boolean; timeouts: boolean;
}
export interface BackendConfig {
  enabled: boolean; mode: AccessMode; endpoint: string; credentialRef: string; timeoutMs: number;
  rateLimitPerMinute: number; dailyAttemptLimit: number; options: Record<string, string | number | boolean>;
}
export interface SearchConfig {
  mode: 'single' | 'parallel'; singleBackend: string; maxResults: number; concurrency: number;
  overallTimeoutMs: number; language: string; region: string; recency: 'any' | 'day' | 'week' | 'month' | 'year';
  safeSearch: boolean; includeDomains: string[]; excludeDomains: string[]; dedup: 'url' | 'url-title';
  fusion: 'rrf' | 'ordered'; retry: RetryConfig;
  cache: { enabled: boolean; ttlSeconds: number; maxEntries: number };
  breaker: { enabled: boolean; threshold: number; cooldownMs: number };
  diagnostics: { enabled: boolean; maxEntries: number };
  backends: Record<string, BackendConfig>;
}
export interface Source { url: string; title?: string; snippet?: string; summary?: string; publishedAt?: string }
export interface SearchInput { query: string; maxResults?: number }
/** Per-call strategy; it never mutates saved configuration. */
export interface SearchOverrides { mode?: 'single' | 'parallel'; backends?: string[] | 'all'; exclude?: string[]; backend?: string; maxResults?: number; compact?: boolean }
export interface AdapterInput {
  query: string; maxResults: number; config: SearchConfig; backend: BackendConfig; key?: string; signal: AbortSignal;
}
export interface AdapterResult { sources: Source[]; content?: string; warnings?: string[] }
export type FailureKind = 'configuration' | 'authentication' | 'quota' | 'rate-limit' | 'http' | 'network' | 'timeout' | 'cancelled' | 'protocol' | 'budget' | 'circuit-open' | 'unverified';
export interface BackendOutcome {
  backend: string; mode: AccessMode; ok: boolean; attempts: number; durationMs: number;
  sources: Source[]; warnings: string[]; error?: { kind: FailureKind; message: string; status?: number }; at?: number;
}
export interface SearchResult {
  sources: Source[]; content: string; truncated: boolean; outcomes: BackendOutcome[]; cached: boolean;
}
export interface SettingsSnapshot {
  config: SearchConfig; defaults: SearchConfig; revision: string; catalog: BackendDefinition[];
  /** Which provider the web seam currently selected, and whether it is this plugin. */
  active: { searchProvider?: string; isSelf: boolean };
  credentials: Record<string, { configured: boolean; writable: boolean }>;
  diagnostics: BackendOutcome[]; counters: Record<string, { attempts: number; day: string }>;
}
export interface ConfigIssue { path: string; message: string }
