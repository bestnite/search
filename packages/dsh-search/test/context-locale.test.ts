import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { catalog } from '@nite07/search-core';

test('dynamic context and mode labels exist in both languages', () => {
  const locales = ['en', 'zh'].map(language => JSON.parse(readFileSync(new URL(`../locale/${language}.json`, import.meta.url), 'utf8')));
  const choices = ['any', 'day', 'week', 'month', 'year', 'url', 'url-title', 'rrf', 'ordered', ...catalog.flatMap(provider => provider.modes.map(mode => mode.mode))];
  for (const locale of locales) {
    for (const context of ['isolated', 'session']) assert.ok(locale[`browserContext.${context}`], `context ${context}`);
    for (const choice of choices) assert.ok(locale[`choice.${choice}`], `choice ${choice}`);
    assert.notEqual(locale['browserContext.session'], locale['choice.session'], 'context selection is not the cookie authentication mode');
  }
  const client = readFileSync(new URL('../src/client.tsx', import.meta.url), 'utf8');
  assert.ok(client.includes("path === 'pageFetch.browser.context' ? t(`browserContext.${choice}`)"));
});
