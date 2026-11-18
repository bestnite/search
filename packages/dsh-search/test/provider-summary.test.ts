import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { catalog } from '@nite07/search-core/static';

test('fetch summary tiers describe fetching rather than borrowing search prices', () => {
  const expected: Record<string, string[]> = {
    exa: ['free', 'paid'], parallel: ['free', 'paid'], deepseek: ['paid'],
    serpex: ['paid'], linkup: ['paid'], tavily: ['free', 'allowance'],
    you: ['paid'], keenable: ['free', 'allowance'], anysearch: ['free', 'allowance'],
    doubao: ['allowance'], 'open-websearch': ['self-hosted'],
  };
  const providers = catalog.filter(def => def.fetch);
  assert.deepEqual(providers.map(def => def.id).sort(), Object.keys(expected).sort());
  for (const def of providers) {
    assert.deepEqual(def.fetch!.modes.map(mode => def.fetch!.modeConstraints?.[mode]?.tier), expected[def.id], def.id);
  }
  const you = providers.find(def => def.id === 'you')!;
  assert.equal(you.fetch!.modeConstraints!.key!.tier, 'paid', 'keyed fetching has no free search allowance');
});

test('search and fetch use one mode-chip renderer without losing fetch evidence or operation status', async () => {
  const source = await readFile(new URL('../src/client.tsx', import.meta.url), 'utf8');
  assert.match(source, /modeChip\(item.mode, item.tier, item.mode === backend.mode\)/);
  assert.match(source, /modeChip\(mode, def.fetch\?\.modeConstraints\?\.\[mode as AccessMode\]\?\.tier \?\? 'unverified', mode === modeLabel, evidenceLabel\(def, mode\), documented\)/);
  assert.match(source, /documented \? ` · \$\{t\('fetchEvidenceBadge'\)\}`/);
  assert.match(source, /selected \? t\('fetchProviderSelected'\) : t\('fetchProviderNotSelected'\)/);
  assert.match(source, /backend.enabled \? t\('enabled'\) : t\('disabled'\)/);
});

test('both summaries share title columns, status width and narrow-screen wrapping', async () => {
  const css = await readFile(new URL('../src/client.overrides.css', import.meta.url), 'utf8');
  assert.match(css, /\.ns-backend > summary\{display:grid;grid-template-columns:10px minmax\(120px,1fr\) minmax\(0,auto\)/);
  assert.match(css, /\.ns-backend > summary \.ns-badge\{[^}]*min-width:6em;white-space:nowrap/);
  assert.match(css, /@media \(max-width:720px\)\{[^\n]*\.ns-backend > summary > \.ns-chips\{grid-column:2;justify-content:flex-start\}/);
  assert.doesNotMatch(css, /\.ns-provider-card > summary\{/);
  assert.match(css, /\.ns-provider-card\{margin:16px 0\}/);
});
