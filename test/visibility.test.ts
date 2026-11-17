import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { blockersOf, visible } from '../src/visibility.js';

test('single-backend selection is only applicable in single mode and its value survives mode switches', () => {
  const config = defaultConfig();
  config.mode = 'parallel';
  assert.equal(visible('singleBackend', config), false);
  config.mode = 'single';
  assert.equal(visible('singleBackend', config), true);
  assert.equal(visible('mode', config), true);
});

test('dependent settings are hidden by their owning switch without being reset', () => {
  const config = defaultConfig();
  config.retry.enabled = false;
  config.breaker.enabled = false;
  config.cache.enabled = false;
  config.diagnostics.enabled = false;
  for (const path of ['retry.statuses', 'retry.maxRetries', 'retry.initialDelayMs', 'retry.maxDelayMs', 'retry.networkErrors', 'retry.timeouts', 'breaker.threshold', 'breaker.cooldownMs', 'cache.ttlSeconds', 'cache.maxEntries', 'diagnostics.maxEntries']) assert.equal(visible(path, config), false, path);
  assert.equal(visible('retry.enabled', config), true);
  assert.equal(visible('breaker.enabled', config), true);
  assert.equal(visible('cache.enabled', config), true);
  assert.deepEqual(config.retry.statuses, [408, 429, 500, 502, 503, 504]);
  config.retry.enabled = true;
  assert.equal(visible('retry.maxRetries', config), true);
});

test('pre-flight blockers name the exact problem and target', () => {
  const config = defaultConfig();
  const ids = Object.keys(config.backends);
  const none = blockersOf(config, ids, () => false);
  assert.deepEqual(none.map(item => item.key), ['blockNoBackends']);
  config.mode = 'single';
  config.singleBackend = 'keenable';
  const single = blockersOf(config, ids, () => false, id => id.toUpperCase());
  assert.deepEqual(single.map(item => item.key), ['blockNoBackends', 'blockSingleDisabled']);
  assert.equal(single[1]!.vars.backend, 'KEENABLE');
  config.backends.keenable!.enabled = true;
  config.backends.keenable!.mode = 'key';
  const missing = blockersOf(config, ids, () => false, id => id.toUpperCase());
  assert.deepEqual(missing.map(item => item.key), ['blockMissingCredential']);
  assert.equal(missing[0]!.vars.list, 'KEENABLE');
  assert.deepEqual(blockersOf(config, ids, () => true), []);
  config.backends.keenable!.mode = 'anonymous';
  assert.deepEqual(blockersOf(config, ids, () => false), []);
});
