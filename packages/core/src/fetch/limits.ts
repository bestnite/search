/**
 * Bounds and closed vocabularies for page fetching, kept in a module with no imports at all.
 *
 * The configuration schema, the settings UIs of both hosts and the engine share these numbers. The
 * settings clients bundle this module, so it must never reach a Node built-in or a browser driver.
 */

/** The only formats a caller may ask for. `format` is required on every call. */
export const FETCH_FORMATS = ['html', 'markdown'] as const;

/** Route kinds, in the default order. A saved configuration holds exactly one record of each. */
export const FETCH_ROUTE_KINDS = ['http', 'browser', 'provider'] as const;

/** Rule condition types. Rules are OR; the conditions inside one rule are AND. */
export const FETCH_CONDITION_TYPES = ['status', 'api-status', 'network', 'timeout', 'error', 'match'] as const;

/** Fields a string condition may read. A missing field is unavailable, never an empty string. */
export const FETCH_CONDITION_FIELDS = ['title', 'html', 'text', 'markdown'] as const;

export const FETCH_MATCH_OPERATORS = ['contains', 'equals', 'regex'] as const;

/** Operational failures a typed `error` condition may name. Fatal outcomes are never listed here. */
export const FETCH_FAILURE_KINDS = ['network', 'timeout', 'http', 'provider', 'authentication', 'protocol', 'conversion', 'unsupported-content', 'limit'] as const;

export const FETCH_BROWSER_CONTEXT_MODES = ['isolated', 'session'] as const;

/**
 * Whether the browser route may spend one bounded attempt on a Cloudflare challenge it identified.
 * `off` disables the behaviour entirely; `auto` is the default because a challenge page is a refused
 * page, and one bounded attempt is cheaper for the user than a manual retry.
 */
export const FETCH_CHALLENGE_SOLVERS = ['off', 'auto'] as const;
export const DEFAULT_CHALLENGE_SOLVER = 'auto';

/**
 * Every automatic navigation one page fetch may perform, counted across the whole route: the
 * anti-bot retry and the challenge attempt share this cap, so neither can stack on the other into an
 * unbounded loop. 1 initial + 1 anti-bot retry + 1 challenge retry.
 */
export const MAX_FETCH_NAVIGATIONS = 3;

/** How long one automatic challenge attempt may poll for the challenge to disappear. */
export const CHALLENGE_SOLVE_WINDOW_MS = 10_000;
/**
 * One press per attempt. Pressing again while the widget is verifying is what restarts a challenge
 * that was already passing, and a second press has never turned a refusal into a page.
 */
export const CHALLENGE_MAX_CLICKS = 1;
/** Text a reader would see, below which a captured document still looks like an unrendered shell. */
export const READABLE_TEXT_MIN_CHARS = 200;
/** How long a client-rendered page gets to produce that text before the capture is taken as it is. */
export const RENDER_WINDOW_MS = 5_000;
/**
 * How long a page that just cleared a challenge gets to render. Longer than a plain page load: the
 * challenge platform has to install its clearance cookie, reload, and boot the application behind it.
 * Discourse forums take several seconds, and closing the window before that throws the pass away.
 */
export const CHALLENGE_RENDER_WINDOW_MS = 15_000;
/** The wait between two presses, so a slow render is not clicked three times in one frame. */
export const CHALLENGE_CLICK_INTERVAL_MS = 2_000;
export const CHALLENGE_POLL_INTERVAL_MS = 500;

/** Suggested, editable starting points rather than hidden retry policy. */
export const DEFAULT_ROUTE_TIMEOUT_MS = { http: 20_000, browser: 45_000, provider: 30_000 } as const;
export const DEFAULT_FETCH_OVERALL_TIMEOUT_MS = 90_000;
export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
export const DEFAULT_MAX_RULE_SCAN_CHARS = 100_000;

/** Bounds on the rule language itself, enforced when a configuration is validated and when it runs. */
export const MAX_FETCH_RULES_PER_ROUTE = 8;
export const MAX_CONDITIONS_PER_RULE = 6;
export const MAX_RULE_STATUS_VALUES = 16;
export const MAX_RULE_VALUE_LENGTH = 2_000;
export const MAX_RULE_SCAN_CHARS = 1_000_000;
export const MAX_REGEX_LENGTH = 200;
export const MAX_RULE_ID_LENGTH = 64;
export const MAX_URL_LENGTH = 4_096;
export const MAX_SELECTOR_LENGTH = 200;
export const MAX_BROWSER_SETTLE_MS = 5_000;
export const MIN_ROUTE_TIMEOUT_MS = 1_000;
export const MAX_ROUTE_TIMEOUT_MS = 180_000;
export const MIN_FETCH_OVERALL_TIMEOUT_MS = 1_000;
export const MAX_FETCH_OVERALL_TIMEOUT_MS = 300_000;
export const MAX_FETCH_REDIRECTS = 20;
export const MIN_FETCH_BODY_BYTES = 64 * 1024;
export const MAX_FETCH_BODY_BYTES = 50 * 1024 * 1024;
export const MIN_FETCH_OUTPUT_CHARS = 1_000;
export const MAX_FETCH_OUTPUT_CHARS = 1_000_000;

/** Parsing and conversion never run on an unbounded document, whatever the acquisition limit allows. */
export const MAX_CONVERSION_INPUT_CHARS = 1_000_000;

/** A rule never scans more than this many characters of one field, and the outcome says it truncated. */
export const DEFAULT_RULE_SCAN_LIMIT = 1_000_000;

/** HTTP status codes a status condition may name; 100-599, including 200 when wanted explicitly. */
export const MIN_HTTP_STATUS = 100;
export const MAX_HTTP_STATUS = 599;

/**
 * A page representation is labelled, because the three routes do not produce the same thing.
 * Returned HTML is never executed or inserted into a settings page unsanitized.
 */
export const FETCH_REPRESENTATIONS = ['response-html', 'response-text', 'rendered-dom', 'provider-html', 'provider-markdown'] as const;

/** Why a page fetch stopped. Fatal reasons cannot be turned into a fallback by a rule. */
export const FETCH_STOP_REASONS = ['accepted', 'stopped-on-error', 'exhausted', 'cancelled', 'deadline', 'policy', 'limit'] as const;

export const FETCH_OUTCOME_KINDS = [
  'ok',
  'http-error',
  'network',
  'timeout',
  'provider-error',
  'authentication',
  'protocol',
  'conversion-error',
  'unsupported-format',
  'unsupported-content',
  'policy',
  'limit',
  'cancelled',
] as const;

/** Everything a settings UI needs to build bounded inputs, in one browser-safe object. */
export const FETCH_BOUNDS = {
  routeTimeoutMs: { min: MIN_ROUTE_TIMEOUT_MS, max: MAX_ROUTE_TIMEOUT_MS },
  overallTimeoutMs: { min: MIN_FETCH_OVERALL_TIMEOUT_MS, max: MAX_FETCH_OVERALL_TIMEOUT_MS },
  maxRedirects: { min: 0, max: MAX_FETCH_REDIRECTS },
  maxBodyBytes: { min: MIN_FETCH_BODY_BYTES, max: MAX_FETCH_BODY_BYTES },
  maxOutputChars: { min: MIN_FETCH_OUTPUT_CHARS, max: MAX_FETCH_OUTPUT_CHARS },
  maxRuleScanChars: { min: MIN_FETCH_OUTPUT_CHARS, max: MAX_RULE_SCAN_CHARS },
  settleMs: { min: 0, max: MAX_BROWSER_SETTLE_MS },
  selectorWaitLength: MAX_SELECTOR_LENGTH,
  urlLength: MAX_URL_LENGTH,
  rulesPerRoute: MAX_FETCH_RULES_PER_ROUTE,
  conditionsPerRule: MAX_CONDITIONS_PER_RULE,
  ruleValueLength: MAX_RULE_VALUE_LENGTH,
  regexLength: MAX_REGEX_LENGTH,
  statusCodes: { min: MIN_HTTP_STATUS, max: MAX_HTTP_STATUS },
  statusValuesPerCondition: MAX_RULE_STATUS_VALUES,
} as const;
