import { RE2JS } from 're2js';
import {
  FETCH_CONDITION_FIELDS,
  FETCH_CONDITION_TYPES,
  FETCH_FAILURE_KINDS,
  FETCH_MATCH_OPERATORS,
  MAX_CONDITIONS_PER_RULE,
  MAX_FETCH_RULES_PER_ROUTE,
  MAX_HTTP_STATUS,
  MAX_REGEX_LENGTH,
  MAX_RULE_ID_LENGTH,
  MAX_RULE_STATUS_VALUES,
  MAX_RULE_VALUE_LENGTH,
  MIN_HTTP_STATUS,
} from './limits.js';
import type { FetchConditionField, FetchFailureKind, FetchFallbackCondition, FetchFallbackRule, FetchRouteKind } from './types.js';

/**
 * The fallback rule language: named rules are OR, the conditions inside one rule are AND, and every
 * condition evaluates to true, false or unavailable. Nothing here is an expression editor, a negation
 * or executable code, and a missing field is never treated as an empty string.
 */

/** Values one route outcome can offer a rule. Absent means unavailable, with the reason recorded. */
export interface RuleInputs {
  /** Target main-document status, absent when the route never learned it. */
  statusCode?: number;
  /** Provider API HTTP status, kept distinct from the target status. */
  apiStatus?: number;
  networkFailed?: boolean;
  timedOut?: boolean;
  /** Typed operational failure for a `error` condition; fatal outcomes never reach rules. */
  failure?: FetchFailureKind;
  fields?: Partial<Record<FetchConditionField, string>>;
}

export interface RuleEvaluation {
  matched: boolean;
  /** Ids of rules that matched, in configuration order. */
  ruleIds: string[];
  /** Bounded reasons a condition could not be evaluated, for example `status: the route learned no target status`. */
  unavailable: string[];
}

const regexCache = new Map<string, RE2JS>();

const compile = (pattern: string, caseSensitive: boolean): RE2JS => {
  const key = `${caseSensitive ? 's' : 'i'}:${pattern}`;
  const cached = regexCache.get(key);
  if (cached) return cached;
  const compiled = RE2JS.compile(pattern, caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE);
  // The cache is a small bound: rules are few and validated, so this cannot grow with page content.
  if (regexCache.size > 64) regexCache.clear();
  regexCache.set(key, compiled);
  return compiled;
};

interface ConditionState {
  state: 'true' | 'false' | 'unavailable';
  reason?: string;
}

const TRUE: ConditionState = { state: 'true' };
const FALSE: ConditionState = { state: 'false' };
const unavailable = (reason: string): ConditionState => ({ state: 'unavailable', reason });

const evaluateCondition = (condition: FetchFallbackCondition, inputs: RuleInputs): ConditionState => {
  switch (condition.type) {
    case 'status':
      if (inputs.statusCode === undefined) return unavailable('status: the route learned no target status');
      return condition.statuses.includes(inputs.statusCode) ? TRUE : FALSE;
    case 'api-status':
      if (inputs.apiStatus === undefined) return unavailable('api-status: the provider API status is unknown');
      return condition.statuses.includes(inputs.apiStatus) ? TRUE : FALSE;
    case 'network':
      return inputs.networkFailed === true ? TRUE : FALSE;
    case 'timeout':
      return inputs.timedOut === true ? TRUE : FALSE;
    case 'error':
      return inputs.failure !== undefined && condition.kinds.includes(inputs.failure) ? TRUE : FALSE;
    case 'match': {
      const value = inputs.fields?.[condition.field];
      if (value === undefined) return unavailable(`${condition.field}: this route produced no such field`);
      if (condition.operator === 'regex') {
        try {
          return compile(condition.value, condition.caseSensitive).matcher(value).find() ? TRUE : FALSE;
        } catch {
          // Validation rejects this at save time; a saved file edited by hand still must not throw.
          return unavailable(`${condition.field}: the regular expression could not be evaluated`);
        }
      }
      const haystack = condition.caseSensitive ? value : value.toLowerCase();
      const needle = condition.caseSensitive ? condition.value : condition.value.toLowerCase();
      return (condition.operator === 'equals' ? haystack === needle : haystack.includes(needle)) ? TRUE : FALSE;
    }
    default:
      return unavailable('unknown condition type');
  }
};

/** Evaluate every rule of one route outcome. A rule matches only when all of its conditions are true. */
export function evaluateRules(rules: readonly FetchFallbackRule[], inputs: RuleInputs): RuleEvaluation {
  const ruleIds: string[] = [];
  const reasons = new Set<string>();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    let allTrue = rule.conditions.length > 0;
    // Every condition is evaluated, even after one is false, so diagnostics name each input that was
    // unavailable instead of only the first one that happened to be missing.
    for (const condition of rule.conditions) {
      const result = evaluateCondition(condition, inputs);
      if (result.state === 'unavailable' && result.reason) reasons.add(result.reason);
      if (result.state !== 'true') allTrue = false;
    }
    if (allTrue) ruleIds.push(rule.id);
  }
  return { matched: ruleIds.length > 0, ruleIds, unavailable: [...reasons].slice(0, 12) };
}

/** Bounds from the shared limits module, exported for the settings UIs. */
export const RULE_BOUNDS = {
  maxRulesPerRoute: MAX_FETCH_RULES_PER_ROUTE,
  maxConditionsPerRule: MAX_CONDITIONS_PER_RULE,
  maxStatusValues: MAX_RULE_STATUS_VALUES,
  maxValueLength: MAX_RULE_VALUE_LENGTH,
  maxRegexLength: MAX_REGEX_LENGTH,
  maxRuleIdLength: MAX_RULE_ID_LENGTH,
} as const;

/**
 * Optional starting points. They are ordinary editable rules with no hidden behaviour, shown by the
 * settings UIs as presets: the Cloudflare one is heuristic detection of a challenge page, not a
 * promise to recognise or solve one, and it never triggers on the bare word "cloudflare".
 */
export const STATUS_ERROR_PRESET: FetchFallbackRule = {
  id: 'status-errors',
  enabled: true,
  conditions: [{ type: 'status', statuses: [404, 410, 429, 500, 502, 503, 504] }],
};

export const CLOUDFLARE_CHALLENGE_PRESET: FetchFallbackRule = {
  id: 'cloudflare-challenge',
  enabled: true,
  conditions: [
    { type: 'match', field: 'title', operator: 'contains', value: 'just a moment', caseSensitive: false },
    { type: 'match', field: 'html', operator: 'contains', value: 'challenges.cloudflare.com', caseSensitive: false },
  ],
};

/** Default rules: a network failure and a per-route timeout, and nothing else. */
export const DEFAULT_FALLBACK_RULES: FetchFallbackRule[] = [
  { id: 'network', enabled: true, conditions: [{ type: 'network' }] },
  { id: 'timeout', enabled: true, conditions: [{ type: 'timeout' }] },
];

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

const knownKeys = (value: Record<string, unknown>, allowed: readonly string[]): string[] =>
  Object.keys(value).filter(key => !allowed.includes(key));

/** Validate one route's rules. Returns human-readable issues; an empty array means usable as saved. */
export function validateRules(rules: unknown, routeKind: FetchRouteKind, path: string): string[] {
  const issues: string[] = [];
  if (!Array.isArray(rules)) return [`${path}: Expected an array of fallback rules.`];
  if (rules.length > MAX_FETCH_RULES_PER_ROUTE) issues.push(`${path}: At most ${MAX_FETCH_RULES_PER_ROUTE} rules are allowed per route.`);
  const ids = new Set<string>();
  rules.forEach((rule, index) => {
    const at = `${path}.${index}`;
    if (!isRecord(rule)) {
      issues.push(`${at}: Expected a rule object.`);
      return;
    }
    for (const key of knownKeys(rule, ['id', 'enabled', 'conditions'])) issues.push(`${at}.${key}: Unknown rule field.`);
    const id = rule.id;
    if (typeof id !== 'string' || id.trim() === '' || id.length > MAX_RULE_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(id)) {
      issues.push(`${at}.id: Use 1-${MAX_RULE_ID_LENGTH} letters, digits, hyphens or underscores.`);
    } else if (ids.has(id)) {
      issues.push(`${at}.id: Rule ids must be unique within one route.`);
    } else {
      ids.add(id);
    }
    if (typeof rule.enabled !== 'boolean') issues.push(`${at}.enabled: Expected a boolean.`);
    const conditions = rule.conditions;
    if (!Array.isArray(conditions) || conditions.length === 0) {
      issues.push(`${at}.conditions: A rule needs at least one condition.`);
      return;
    }
    if (conditions.length > MAX_CONDITIONS_PER_RULE) issues.push(`${at}.conditions: At most ${MAX_CONDITIONS_PER_RULE} conditions are allowed per rule.`);
    conditions.forEach((condition, conditionIndex) => {
      issues.push(...validateCondition(condition, `${at}.conditions.${conditionIndex}`, routeKind));
    });
  });
  return issues;
}

function validateCondition(condition: unknown, path: string, routeKind: FetchRouteKind): string[] {
  if (!isRecord(condition)) return [`${path}: Expected a condition object.`];
  const type = condition.type;
  if (typeof type !== 'string' || !(FETCH_CONDITION_TYPES as readonly string[]).includes(type)) {
    return [`${path}.type: Unsupported condition type.`];
  }
  const issues: string[] = [];
  const statuses = (): string[] => {
    const value = condition.statuses;
    const local: string[] = [];
    if (!Array.isArray(value) || value.length === 0) return [`${path}.statuses: Expected at least one HTTP status code.`];
    if (value.length > MAX_RULE_STATUS_VALUES) local.push(`${path}.statuses: At most ${MAX_RULE_STATUS_VALUES} status codes are allowed.`);
    if (value.some(code => !Number.isInteger(code) || (code as number) < MIN_HTTP_STATUS || (code as number) > MAX_HTTP_STATUS)) {
      local.push(`${path}.statuses: Expected integer HTTP status codes from ${MIN_HTTP_STATUS} to ${MAX_HTTP_STATUS}.`);
    }
    return local;
  };
  switch (type) {
    case 'status':
      issues.push(...knownKeys(condition, ['type', 'statuses']).map(key => `${path}.${key}: Unknown condition field.`));
      issues.push(...statuses());
      break;
    case 'api-status':
      issues.push(...knownKeys(condition, ['type', 'statuses']).map(key => `${path}.${key}: Unknown condition field.`));
      if (routeKind !== 'provider') issues.push(`${path}: A provider API status condition is only valid on the provider route.`);
      issues.push(...statuses());
      break;
    case 'network':
    case 'timeout':
      issues.push(...knownKeys(condition, ['type']).map(key => `${path}.${key}: Unknown condition field.`));
      break;
    case 'error': {
      issues.push(...knownKeys(condition, ['type', 'kinds']).map(key => `${path}.${key}: Unknown condition field.`));
      const kinds = condition.kinds;
      if (!Array.isArray(kinds) || kinds.length === 0) issues.push(`${path}.kinds: Expected at least one failure kind.`);
      else {
        if (kinds.length > FETCH_FAILURE_KINDS.length) issues.push(`${path}.kinds: Too many failure kinds.`);
        for (const kind of kinds) {
          if (typeof kind !== 'string' || !(FETCH_FAILURE_KINDS as readonly string[]).includes(kind)) issues.push(`${path}.kinds: Unsupported failure kind.`);
        }
      }
      break;
    }
    case 'match': {
      issues.push(...knownKeys(condition, ['type', 'field', 'operator', 'value', 'caseSensitive']).map(key => `${path}.${key}: Unknown condition field.`));
      if (typeof condition.field !== 'string' || !(FETCH_CONDITION_FIELDS as readonly string[]).includes(condition.field)) {
        issues.push(`${path}.field: Use one of ${FETCH_CONDITION_FIELDS.join(', ')}.`);
      }
      if (typeof condition.operator !== 'string' || !(FETCH_MATCH_OPERATORS as readonly string[]).includes(condition.operator)) {
        issues.push(`${path}.operator: Use one of ${FETCH_MATCH_OPERATORS.join(', ')}.`);
      }
      if (typeof condition.caseSensitive !== 'boolean') issues.push(`${path}.caseSensitive: Expected a boolean.`);
      const value = condition.value;
      if (typeof value !== 'string' || value === '') issues.push(`${path}.value: Expected a non-empty string.`);
      else if (value.length > MAX_RULE_VALUE_LENGTH) issues.push(`${path}.value: At most ${MAX_RULE_VALUE_LENGTH} characters are allowed.`);
      else if (condition.operator === 'regex') {
        if (value.length > MAX_REGEX_LENGTH) issues.push(`${path}.value: A regular expression is limited to ${MAX_REGEX_LENGTH} characters.`);
        else {
          try {
            RE2JS.compile(value, condition.caseSensitive === false ? RE2JS.CASE_INSENSITIVE : 0);
          } catch {
            // RE2 is linear-time by construction; unsupported syntax is refused at save time instead.
            issues.push(`${path}.value: Unsupported regular expression syntax (no lookaround, backreferences, or flags).`);
          }
        }
      }
      break;
    }
  }
  return issues;
}
