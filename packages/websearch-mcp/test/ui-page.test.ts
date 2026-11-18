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

/** How many language tables define this label: a bare `key:` or a quoted `'key':`, once per table. */
function definitions(key: string): number {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = page.match(new RegExp(`'${escaped}':`, 'g')) ?? [];
  // A bare definition is `key:` not preceded by a quote, so `t('key')` and `'key'` values do not count.
  const bare = page.match(new RegExp(`(?<![\\w'"])${escaped}:`, 'g')) ?? [];
  return quoted.length + bare.length;
}

test('the settings page is split into the same six subjects as the plugin page', () => {
  for (const key of ['tabBehavior', 'tabReliability', 'tabDiagnostics', 'tabBackends', 'tabBrowser', 'tabFetch']) {
    assert.equal(definitions(key), 2, `${key} is labelled in both languages`);
  }
  assert.match(page, /const TABS = \['behavior', 'reliability', 'diagnostics', 'backends', 'browser', 'fetch'\]/, 'the tab order is declared once');
  assert.match(page, /behavior: behaviorSection/, 'each tab has its own section');
  for (const help of ['helpBehavior', 'helpReliability', 'helpDiagnostics', 'helpBackends', 'helpBrowser', 'helpFetch']) {
    assert.equal(definitions(help), 2, `${help} explains the tab in both languages`);
  }
});

test('the retired two-tab layout leaves no trace', () => {
  assert.doesNotMatch(page, /tabSearch/, 'the old search tab label is gone');
  assert.doesNotMatch(page, /function overview\(/, 'the page-long overview is gone');
});

test('every route, condition and failure kind the core defines has a label in both languages', () => {
  for (const kind of FETCH_ROUTE_KINDS) {
    assert.equal(definitions(`route.${kind}`), 2, `route.${kind}`);
    assert.equal(definitions(`routeHelp.${kind}`), 2, `routeHelp.${kind}`);
  }
  for (const type of FETCH_CONDITION_TYPES) assert.equal(definitions(`condition.${type}`), 2, `condition.${type}`);
  for (const kind of FETCH_FAILURE_KINDS) assert.equal(definitions(`failure.${kind}`), 2, `failure.${kind}`);
});

test('the search timeout and the fetch deadline no longer share one label', () => {
  assert.equal(definitions('overallTimeout'), 2, 'the search timeout keeps its own key');
  assert.equal(definitions('fetchOverallTimeout'), 2, 'the fetch deadline has its own');
  assert.match(page, /pageFetch\.overallTimeoutMs', type: 'number', label: t\('fetchOverallTimeout'\)/, 'and the fetch field uses it');
});
