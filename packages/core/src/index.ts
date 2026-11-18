/**
 * Public surface of @nite07/search-core: a provider-agnostic search engine with an
 * explicit access mode per backend, bounded retries and honest failure reporting.
 * Nothing here depends on DeepSeek Harness, so any host can drive it.
 */
export { catalog } from './catalog.js';
export {
  backendCredentialRef,
  browserCredentialRef,
  defaultConfig,
  defaultFetchBackendConfig,
  defaultFetchRoutes,
  defaultPageFetchConfig,
  parseConfig,
  validateConfig,
} from './config.js';
export { SearchEngine } from './engine.js';
export { revision } from './engine.js';
export type { ConfigIssue, ConfigIssueAction, ConfigIssueParams, SearchOverrides, SearchResult, BackendOutcome } from './types.js';
export type {
  AccessMode,
  BackendConfig,
  BackendDefinition,
  CostTier,
  Localized,
  ModeDefinition,
  OptionField,
  RetryConfig,
  SearchConfig,
  SearchInput,
  Source,
} from './types.js';
export { SearchError } from './transport.js';
export { LANGUAGES, REGIONS } from './locale-map.js';
export { appUserAgent, setUserAgent } from './ua.js';
export { VERSION, PROJECT_URL } from './version.js';
export { runAdapter, browserBackends, type BrowserRead } from './adapters.js';
export { DEFAULT_MAX_CONCURRENT_READS, MAX_CONCURRENT_READS, MIN_MAX_CONCURRENT_READS } from './browser-limits.js';
export { fetchRedditThread, searchReddit } from './reddit/index.js';
export type { RedditComment, RedditCredentials, RedditThread } from './reddit/index.js';
export { parseXCredentials, searchX } from './x/index.js';
export type { XCredentials } from './x/index.js';
export { fetchXThread, normaliseId } from './x/thread.js';
export { fetchXhsComments, fetchXhsNote, readXhsSearchNotes, resolveTarget as resolveXhsTarget, searchXhs } from './xhs/index.js';
export { formatXhsNote, renderXhsNote } from './xhs/render.js';
export type { XhsNoteReport } from './xhs/render.js';
export type { XhsComment, XhsContext, XhsNote, XhsNoteSummary } from './xhs/index.js';
export { materialiseImages, mediaDir, type MediaImage, type MediaOptions } from './media.js';
export { BrowserSession, closeBrowserSessions, connectFailure, sessionFor, type BrowserReader, type BrowserSessionOptions } from './browser.js';
export { parseBrowserEndpoint } from './browser-endpoint.js';
export {
  BROWSER_VERIFICATION_TIMEOUT_MS,
  BrowserVerificationAborted,
  collectBrowserDependencies,
  defaultVerificationConnect,
  verifyBrowserDependencies,
  verifyBrowserEndpoint,
} from './browser-verification.js';
export type {
  BrowserDependency,
  BrowserVerificationCheck,
  BrowserVerificationResult,
  VerificationBrowser,
  VerificationConnect,
  VerificationContext,
  VerificationOptions,
} from './browser-verification.js';
export type { XThread } from './x/thread.js';
export type { XReply, XThreadPost } from './x/parse.js';
// Page fetching: one URL in, one bounded page out, through ordered configurable routes.
export { PageFetchEngine, createPageFetchEngine, type PageFetchDependencies } from './fetch/engine.js';
export { renderPageFetchReport } from './fetch/report.js';
export { fetchReadiness, fetchProblemText, fetchReadinessProviders } from './fetch/readiness.js';
export type { FetchReadinessProblem, FetchReadinessProvider } from './fetch/readiness.js';
export { PageFetchError } from './fetch/types.js';
export type {
  FetchAttempt,
  FetchApiStatusCondition,
  FetchBackendConfig,
  FetchBrowserContextMode,
  FetchConditionField,
  FetchErrorCondition,
  FetchFailureKind,
  FetchFallbackCondition,
  FetchFallbackRule,
  FetchFormat,
  FetchMatchCondition,
  FetchMatchOperator,
  FetchNetworkCondition,
  FetchOperationDefinition,
  FetchOutcomeKind,
  FetchRepresentation,
  FetchRouteConfig,
  FetchRouteKind,
  FetchStatusCondition,
  FetchStopReason,
  FetchTimeoutCondition,
  PageFetchConfig,
  PageFetchErrorKind,
  PageFetchInput,
  PageFetchResult,
} from './fetch/types.js';
export { evaluateRules, validateRuleIssues, validateRules, type RuleEvaluation, type RuleInputs, type RuleIssue } from './fetch/rules.js';
export {
  FETCH_BOUNDS,
  FETCH_CONDITION_FIELDS,
  FETCH_CONDITION_TYPES,
  FETCH_FAILURE_KINDS,
  FETCH_MATCH_OPERATORS,
  FETCH_ROUTE_KINDS,
} from './fetch/limits.js';
export { CLOUDFLARE_CHALLENGE_PRESET, DEFAULT_FALLBACK_RULES, STATUS_ERROR_PRESET } from './fetch/rules.js';
