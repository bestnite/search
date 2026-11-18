import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, parseConfig, revision } from '../src/index.js';
import { canonicalJson, orderLike, sameConfig } from '../src/canonical.js';

/**
 * One configuration, one revision.
 *
 * A saved configuration reaches this library in several shapes: the row a user wrote, the object a
 * host's schema resolved, and the normalized value `parseConfig()` returns. When those shapes differ
 * only in key insertion order — which is exactly what filling a newer block into an older save does —
 * a text comparison reports a conflict that does not exist. These tests pin the comparison, the
 * normalization and the hash together, so a settings page can rely on them.
 */

test('canonicalization ignores key order and keeps array order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(sameConfig({ nested: { y: 1, x: 2 } }, { nested: { x: 2, y: 1 } }), true);
  assert.equal(sameConfig({ list: [1, 2] }, { list: [2, 1] }), false, 'an array order is content');
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}', 'JSON drops an undefined property');
  assert.equal(canonicalJson([undefined, 1]), '[null,1]', 'JSON turns an undefined element into null');
});

test('a value JSON cannot carry throws instead of hashing something else', () => {
  assert.throws(() => canonicalJson({ a: 1n }), /bigint/);
  assert.throws(() => canonicalJson({ a: () => 1 }), /function/);
  assert.throws(() => canonicalJson({ a: Number.NaN }), /non-finite/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cycle/);
});

test('the same values under a different key order have one revision', () => {
  const base = defaultConfig();
  const reordered: Record<string, unknown> = {};
  for (const key of Object.keys(base).reverse()) reordered[key] = (base as unknown as Record<string, unknown>)[key];
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(base));
  assert.equal(revision(reordered as never), revision(base));

  const changed = structuredClone(base);
  changed.maxResults += 1;
  assert.notEqual(revision(changed), revision(base));

  const reorderedRoutes = structuredClone(base);
  const [first, second] = [reorderedRoutes.pageFetch.routes[0]!, reorderedRoutes.pageFetch.routes[1]!];
  reorderedRoutes.pageFetch.routes = [second, first, reorderedRoutes.pageFetch.routes[2]!];
  assert.notEqual(revision(reorderedRoutes), revision(base), 'route order is part of the configuration');
});

test('a configuration saved before a newer block existed normalizes to one shape', () => {
  const legacy = defaultConfig() as unknown as Record<string, unknown>;
  delete legacy.pageFetch;
  for (const row of Object.values(legacy.backends as Record<string, Record<string, unknown>>)) delete row.fetch;

  const loaded = parseConfig(legacy);
  assert.equal(JSON.stringify(loaded), JSON.stringify(parseConfig(defaultConfig())), 'the filled block lands where the defaults put it');
  assert.equal(revision(loaded), revision(parseConfig(defaultConfig())), 'and hashes like the same configuration');
  assert.deepEqual(Object.keys(loaded).slice(-2), ['pageFetch', 'backends'], 'a filled key is not appended after the known ones');
  assert.deepEqual(Object.keys(loaded), Object.keys(defaultConfig()), 'the shape follows the defaults, not the save');
});

test('orderLike keeps unknown keys, after the known ones', () => {
  assert.deepEqual(Object.keys(orderLike({ a: 1, b: 2 }, { b: 0, a: 0, extra: true }) as object), ['a', 'b', 'extra']);
  assert.deepEqual(Object.keys(orderLike({ a: 1 }, { z: 1, a: 2 }) as object), ['a', 'z']);
  assert.deepEqual(Object.keys((orderLike([{ a: 1 }], [{ b: 2, a: 1 }]) as Array<object>)[0]!), ['a', 'b'], 'array items take their exemplar order and keep their own keys');
});
