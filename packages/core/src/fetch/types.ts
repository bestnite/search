import type { AccessMode, Localized } from '../types.js';
import type {
  FETCH_BROWSER_CONTEXT_MODES,
  FETCH_CHALLENGE_SOLVERS,
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
export type FetchChallengeSolver = (typeof FETCH_CHALLENGE_SOLVERS)[number];

/**
 * How one fetch access mode talks to the provider: the shared MCP tool call, or a plain REST POST to
 * the mode's own endpoint. The transport is declared per mode rather than guessed from the endpoint,
 * so one provider can offer both without a second provider route.
 */
export type FetchTransport = 'mcp' | 'rest';

/**
 * What is actually known about one fetch access mode.
 *
 * `live` was observed from this deployment; `documented` was implemented from the provider's official
 * contract and no call was made, because that would have needed a paid credential. A documented-only
 * mode is still selectable, and every surface that shows it has to say which of the two it is.
 */
export interface FetchModeEvidence {
  evidence: 'live' | 'documented';
  /** Date the contract was observed live, or the date the documentation was read for a documented mode. */
  verifiedAt: string;
  /** Where a documented mode's contract was read. */
  source?: string;
  notes?: Localized;
}

/**
 * What one fetch access mode costs and what it is allowed.
 *
 * This is per mode, not per provider: one provider can fetch keylessly for free and with a key for
 * money, and the price of a fetch is not the price of a search. The settings page shows the entry of
 * the selected mode, so the cost is known before the mode is enabled rather than after a bill.
 */
export interface FetchModeConstraint {
  limits: Localized;
  pricingUrl?: string;
}

/**
 * What one catalog entry can do for a page fetch. This is metadata, not a user toggle: a provider is
 * fetch-capable because its contract says so, and a search-only provider cannot be selected for it.
 */
export interface FetchOperationDefinition {
  /**
   * The MCP tool this operation calls, when one exists. A provider whose fetch operation is a plain
   * REST API has no tool, and its modes all declare the `rest` transport instead.
   */
  tool?: string;
  /** Access modes declared for fetching. Selecting any other mode is a configuration error. */
  modes: AccessMode[];
  /**
   * Transport per access mode. An absent entry is the MCP tool call, so a saved mode keeps the
   * behaviour it had before a REST mode was added.
   */
  transport?: Partial<Record<AccessMode, FetchTransport>>;
  /**
   * Fetch endpoint per access mode, when it differs from that mode's search endpoint. Set explicitly:
   * a search URL is never string-rewritten into a fetch endpoint. An entry is also what gives a fetch
   * mode an endpoint when the provider has no search mode of that name.
   */
  endpoints?: Partial<Record<AccessMode, string>>;
  /**
   * Evidence per access mode. An absent entry was observed live and shares the operation's
   * `verifiedAt`, which is how the first fetch providers were recorded; a mode added later states its
   * own evidence explicitly, because inheriting a live date it was never observed on would overclaim.
   */
  evidence?: Partial<Record<AccessMode, FetchModeEvidence>>;
  /** Cost and quota per access mode, so the settings page shows what a mode spends before enabling it. */
  modeConstraints?: Partial<Record<AccessMode, FetchModeConstraint>>;
  /**
   * Formats the operation can satisfy for a caller. A Markdown-only provider cannot serve HTML, and
   * a provider that can return the page's own HTML says so here. The representation of one response
   * is decided by the adapter that produced it and reported on the attempt, never by this metadata.
   */
  serves: FetchFormat[];
  /** Operation-specific options, kept separate from the search options of the same provider. */
  options: import('../types.js').OptionField[];
  /** Documentation of the operation itself, distinct from the provider's search documentation. */
  docs: string;
  /** Date this operation's anonymous contract was last observed live, or last read when none was. */
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
    /**
     * `auto` spends one bounded attempt on a Cloudflare challenge the browser route identified: it
     * clicks the widget through the driver, polls for the challenge to disappear, and navigates once
     * more when it did. It never waits for a person, and `off` disables the behaviour completely.
     */
    challengeSolver: FetchChallengeSolver;
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
