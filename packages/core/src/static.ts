/**
 * Browser-safe surface: the backend catalog, the configuration schema, the page-fetch bounds and the
 * locale tables. Nothing here imports a Node built-in or a browser driver, so a settings UI can
 * bundle it. The engines themselves stay in the main entry, which is meant for Node.
 */
export { catalog } from './catalog.js';
export { defaultConfig, defaultFetchBackendConfig, defaultFetchRoutes, defaultPageFetchConfig, parseConfig, validateConfig } from './config.js';
export { DEFAULT_MAX_CONCURRENT_READS, MAX_CONCURRENT_READS, MIN_MAX_CONCURRENT_READS } from './browser-limits.js';
export { LANGUAGES, REGIONS } from './locale-map.js';
export { FETCH_BOUNDS, FETCH_CONDITION_FIELDS, FETCH_CONDITION_TYPES, FETCH_FAILURE_KINDS, FETCH_MATCH_OPERATORS, FETCH_ROUTE_KINDS } from './fetch/limits.js';
export { CLOUDFLARE_CHALLENGE_PRESET, DEFAULT_FALLBACK_RULES, STATUS_ERROR_PRESET } from './fetch/rules.js';
export type {
  AccessMode,
  BackendConfig,
  BackendDefinition,
  ConfigIssue,
  CostTier,
  Localized,
  ModeDefinition,
  OptionField,
  RetryConfig,
  SearchConfig,
  Source,
} from './types.js';
export type {
  FetchBackendConfig,
  FetchConditionField,
  FetchFallbackCondition,
  FetchFallbackRule,
  FetchFormat,
  FetchMatchOperator,
  FetchOperationDefinition,
  FetchRouteConfig,
  FetchRouteKind,
  PageFetchConfig,
} from './fetch/types.js';
