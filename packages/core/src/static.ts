/**
 * Browser-safe surface: the backend catalog, the configuration schema and the locale tables.
 * Nothing here imports a Node built-in, so a settings UI can bundle it. The engine itself stays
 * in the main entry, which is meant for Node.
 */
export { catalog } from './catalog.js';
export { defaultConfig, parseConfig, validateConfig } from './config.js';
export { DEFAULT_MAX_CONCURRENT_READS, MAX_CONCURRENT_READS, MIN_MAX_CONCURRENT_READS } from './browser-limits.js';
export { LANGUAGES, REGIONS } from './locale-map.js';
export type {
  AccessMode,
  BackendConfig,
  BackendDefinition,
  ConfigIssue,
  CostTier,
  ModeDefinition,
  OptionField,
  RetryConfig,
  SearchConfig,
  Source,
} from './types.js';
