/**
 * Public surface of @nite07/search-core: a provider-agnostic search engine with an
 * explicit access mode per backend, bounded retries and honest failure reporting.
 * Nothing here depends on DeepSeek Harness, so any host can drive it.
 */
export { catalog } from './catalog.js';
export { defaultConfig, parseConfig, validateConfig } from './config.js';
export { SearchEngine } from './engine.js';
export { revision } from './engine.js';
export type { ConfigIssue, SearchOverrides, SearchResult, BackendOutcome } from './types.js';
export type {
  AccessMode,
  BackendConfig,
  BackendDefinition,
  CostTier,
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
export { runAdapter } from './adapters.js';
export { fetchRedditThread, searchReddit } from './reddit/index.js';
export type { RedditComment, RedditCredentials, RedditThread } from './reddit/index.js';
export { parseXCredentials, searchX } from './x/index.js';
export type { XCredentials } from './x/index.js';
export { fetchXThread, normaliseId } from './x/thread.js';
export { fetchXhsComments, fetchXhsNote, readXhsSearchNotes, resolveTarget as resolveXhsTarget, searchXhs } from './xhs/index.js';
export type { XhsComment, XhsContext, XhsNote, XhsNoteSummary } from './xhs/index.js';
export { BrowserSession, closeBrowserSessions, connectFailure, sessionFor, type BrowserSessionOptions } from './browser.js';
export type { XThread } from './x/thread.js';
export type { XReply, XThreadPost } from './x/parse.js';
