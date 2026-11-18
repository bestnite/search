import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FETCH_CONDITION_TYPES,
  FETCH_FAILURE_KINDS,
  FETCH_ROUTE_KINDS,
} from '@nite07/search-core';

/**
 * The page is one HTML file with two language tables in it, so its structure can only be checked by
 * reading that file. These assertions pin the two things that broke before: a two-tab layout that put
 * unrelated settings on one page, and labels that were asked for but never written, which showed the
 * reader raw keys like `failure.unsupported-content`.
 */
const page = await readFile(new URL('../src/ui/page.html', import.meta.url), 'utf8');

/** How many times this label is defined: a bare `key:` or a quoted `'key':`, exactly once now. */
function definitions(key: string): number {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = page.match(new RegExp(`'${escaped}':`, 'g')) ?? [];
  // A bare definition is `key:` not preceded by a quote, so `t('key')` and `'key'` values do not count.
  const bare = page.match(new RegExp(`(?<![\\w'"])${escaped}:`, 'g')) ?? [];
  return quoted.length + bare.length;
}

test('the settings page is split into the same six subjects as the plugin page', () => {
  for (const key of ['tabBehavior', 'tabReliability', 'tabDiagnostics', 'tabBackends', 'tabBrowser', 'tabFetch']) {
    assert.equal(definitions(key), 1, `${key} is labelled once, in Chinese`);
  }
  assert.match(page, /const TABS = \['behavior', 'reliability', 'diagnostics', 'backends', 'browser', 'fetch'\]/, 'the tab order is declared once');
  assert.match(page, /behavior: behaviorSection/, 'each tab has its own section');
  for (const help of ['helpBehavior', 'helpReliability', 'helpDiagnostics', 'helpBackends', 'helpBrowser', 'helpFetch']) {
    assert.equal(definitions(help), 1, `${help} explains the tab`);
  }
});

test('the retired two-tab layout leaves no trace', () => {
  assert.doesNotMatch(page, /tabSearch/, 'the old search tab label is gone');
  assert.doesNotMatch(page, /function overview\(/, 'the page-long overview is gone');
});

test('every route, condition and failure kind the core defines has a label', () => {
  for (const kind of FETCH_ROUTE_KINDS) {
    assert.equal(definitions(`route.${kind}`), 1, `route.${kind}`);
    assert.equal(definitions(`routeHelp.${kind}`), 1, `routeHelp.${kind}`);
  }
  for (const type of FETCH_CONDITION_TYPES) assert.equal(definitions(`condition.${type}`), 1, `condition.${type}`);
  for (const kind of FETCH_FAILURE_KINDS) assert.equal(definitions(`failure.${kind}`), 1, `failure.${kind}`);
});

test('the search timeout and the fetch deadline no longer share one label', () => {
  assert.equal(definitions('overallTimeout'), 1, 'the search timeout keeps its own key');
  assert.equal(definitions('fetchOverallTimeout'), 1, 'the fetch deadline has its own');
  assert.match(page, /pageFetch\.overallTimeoutMs', type: 'number', label: t\('fetchOverallTimeout'\)/, 'and the fetch field uses it');
});

/**
 * The fetch tab once read `provider.options`, `provider.docs` and `provider.verifiedAt` off the
 * readiness entry, which only carries id, title, serves, modes, endpoint and the two credential flags.
 * The undefined read threw while rendering, the tab swap aborted, and the button looked dead.
 */
test('the fetch provider panel reads only fields the readiness entry actually has', () => {
  const allowed = new Set(['id', 'title', 'serves', 'modes', 'endpoint', 'credentialRequired', 'credentialConfigured']);
  const read = [...page.matchAll(/\bprovider\.([A-Za-z]+)/g)].map(match => match[1]!);
  assert.ok(read.length >= 5, 'the page still reads a provider');
  for (const field of new Set(read)) assert.ok(allowed.has(field), `provider.${field} is not part of the readiness entry`);
});

test('a section that throws is reported instead of silently keeping the previous tab', () => {
  assert.match(page, /catch \(error\) \{\s*\n\s*const message = error instanceof Error/, 'the section render is guarded');
  assert.equal(definitions('sectionFailed'), 1, 'and says so on the page');
});

test('the page carries no second language', () => {
  assert.match(page, /^const TEXT = \{$/m, 'the strings live in one table');
  assert.doesNotMatch(page, /^\s{2}en: \{$/m, 'there is no English table');
  assert.doesNotMatch(page, /id="lang"/, 'there is no language switch');
  assert.doesNotMatch(page, /state\.lang/, 'and no language state to read');
});
