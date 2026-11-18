import type { AccessMode, Localized } from '../types.js';
import type {
  FETCH_BROWSER_CONTEXT_MODES,
  FETCH_CONDITION_FIELDS,
  FETCH_FAILURE_KINDS,
  FETCH_FORMATS,
  FETCH_MATCH_OPERATORS,
  FETCH_OUTCOME_KINDS,
  FETCH_REPRESENTATIONS,
  FETCH_ROUTE_KINDS,
  FETCH_STOP_REASONS,
} from './limits.js';

export type FetchFormat = (typeof FETCH_FORMATS)[number];
export type FetchRouteKind = (typeof FETCH_ROUTE_KINDS)[number];
export type FetchRepresentation = (typeof FETCH_REPRESENTATIONS)[number];
export type FetchStopReason = (typeof FETCH_STOP_REASONS)[number];
export type FetchOutcomeKind = (typeof FETCH_OUTCOME_KINDS)[number];
export type FetchFailureKind = (typeof FETCH_FAILURE_KINDS)[number];
export type FetchConditionField = (typeof FETCH_CONDITION_FIELDS)[number];
export type FetchMatchOperator = (typeof FETCH_MATCH_OPERATORS)[number];
export type FetchBrowserContextMode = (typeof FETCH_BROWSER_CONTEXT_MODES)[number];

/**
 * What one catalog entry can do for a page fetch. This is metadata, not a user toggle: a provider is
 * fetch-capable because its contract says so, and a search-only provider cannot be selected for it.
 */
export interface FetchOperationDefinition {
  /** The one MCP tool this adapter calls. There is no scan and no failover between tools. */
  tool: string;
  /** Access modes in which the operation was verified. Selecting any other mode is a config error. */
  modes: AccessMode[];
  /** Formats the operation can satisfy for a caller. A Markdown-only provider cannot serve HTML. */
  serves: FetchFormat[];
  /** The representation its response is labelled with. */
  representation: FetchRepresentation;
  /** Operation-specific options, kept separate from the search options of the same provider. */
  options: import('../types.js').OptionField[];
  /** Provider field that bounds characters per page, and the default the adapter sends. */
  characterOption?: { key: string; default: number };
  /** Documentation of the operation itself, distinct from the provider's search documentation. */
  docs: string;
  /** Date this operation's anonymous contract was last observed live. */
  verifiedAt: string;
  notes?: Localized;
}

/** Per-provider fetch settings. They are deliberately not the search endpoint or timeout. */
export interface FetchBackendConfig {
  mode: AccessMode;
  endpoint: string;
  timeoutMs: number;
  options: Record<string, string | number | boolean>;
}

export interface FetchStatusCondition {
  type: 'status';
  /** Target main-document HTTP status members. 100-599, including 200 when wanted explicitly. */
  statuses: number[];
}

export interface FetchApiStatusCondition {
  type: 'api-status';
  /** Provider API HTTP status members; valid only on the provider route, separate from target status. */
  statuses: number[];
}

export interface FetchNetworkCondition {
  type: 'network';
}

export interface FetchTimeoutCondition {
  type: 'timeout';
}

export interface FetchErrorCondition {
  type: 'error';
  /** Typed operational failures (authentication, protocol, conversion, ...), not fatal policy errors. */
  kinds: FetchFailureKind[];
}

export interface FetchMatchCondition {
  type: 'match';
  field: FetchConditionField;
  operator: FetchMatchOperator;
  value: string;
  /** Explicit, never implicit: a case-insensitive rule has to say so. */
  caseSensitive: boolean;
}

export type FetchFallbackCondition =
  | FetchStatusCondition
  | FetchApiStatusCondition
  | FetchNetworkCondition
  | FetchTimeoutCondition
  | FetchErrorCondition
  | FetchMatchCondition;

/** One named rule. Conditions inside a rule are AND; the rules of a route are OR. */
export interface FetchFallbackRule {
  id: string;
  enabled: boolean;
  conditions: FetchFallbackCondition[];
}

export interface FetchRouteConfig {
  kind: FetchRouteKind;
  enabled: boolean;
  timeoutMs: number;
  rules: FetchFallbackRule[];
}

export interface PageFetchConfig {
  /** Exactly one record per route kind, in execution order. Enabled is independent of position. */
  routes: FetchRouteConfig[];
  /** The one fetch-capable provider the provider route may use; empty means none selected. */
  providerId: string;
  overallTimeoutMs: number;
  maxRedirects: number;
  maxBodyBytes: number;
  maxOutputChars: number;
  maxRuleScanChars: number;
  /** Default public-only. Explicitly opting in exposes the local network to fetched targets. */
  allowPrivateNetworks: boolean;
  /**
   * A browser or provider route resolves the target URL outside this process, so the local address
   * checks cannot prove its destination policy. Enabling such a route is that decision; there is no
   * separate switch, and every delegated result carries the trust note.
   */
  browser: {
    context: FetchBrowserContextMode;
    settleMs: number;
    selectorWait: string;
  };
}

export interface PageFetchInput {
  url: string;
  format: FetchFormat;
}

/** Sanitized, bounded per-attempt diagnostics. Never a page copy, a token or a raw exception dump. */
export interface FetchAttempt {
  route: FetchRouteKind;
  provider?: string;
  durationMs: number;
  outcome: FetchOutcomeKind;
  /** Target main-document status, when the route actually learned it. */
  statusCode?: number;
  /** Provider API HTTP status, kept distinct from the target status. */
  apiStatus?: number;
  representation?: FetchRepresentation;
  /** Ids of the fallback rules this outcome matched; empty means no rule matched. */
  rules: string[];
  /** Rule inputs that were missing, with a bounded reason, for example `title: the provider returns no title`. */
  unavailable: string[];
  error?: { kind: FetchFailureKind | 'policy' | 'configuration'; message: string; status?: number };
}

export interface PageFetchResult {
  requestedUrl: string;
  finalUrl?: string;
  format: FetchFormat;
  content?: string;
  contentRoute?: FetchRouteKind;
  contentProvider?: string;
  representation?: FetchRepresentation;
  statusCode?: number;
  /** True only for an acceptable successful result, not merely a completed transport. */
  ok: boolean;
  stopReason: FetchStopReason;
  truncated: boolean;
  attempts: FetchAttempt[];
  /** Bounded explanations: truncation, unavailable rule inputs, the delegated trust boundary. */
  notes: string[];
}

export type PageFetchErrorKind = 'invalid-input' | 'configuration';

/** Thrown before execution: a malformed call or a configuration that cannot fetch at all. */
export class PageFetchError extends Error {
  constructor(public kind: PageFetchErrorKind, message: string) {
    super(message);
    this.name = 'PageFetchError';
  }
}
