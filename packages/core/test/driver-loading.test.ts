import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    return entry.isDirectory() ? sources(`${path}/`) : [path];
  });

/**
 * A static import of the driver runs its bootstrap while this package is being imported. One machine
 * where that bootstrap cannot complete then reports the plugin as unloadable — a browser it never asked
 * for. Every value import therefore belongs in `playwright-driver.ts`, behind the first use that needs a
 * browser; a type-only import costs nothing because the compiler erases it.
 */
test('only the driver loader imports patchright-core at load time', () => {
  const offenders = sources(src)
    .filter(path => path.endsWith('.ts') && !path.endsWith('playwright-driver.ts'))
    .filter((path) => {
      const text = readFileSync(path, 'utf8');
      const valueImport = /^\s*import\s+(?!type\b)[^;]*?from\s*['"]patchright-core['"]/m.test(text);
      const required = /\brequire\(\s*['"]patchright-core['"]\s*\)/.test(text);
      return valueImport || required;
    })
    .map(path => path.slice(src.length));
  assert.deepEqual(offenders, [], `these modules must load the driver through playwright-driver.ts: ${offenders.join(', ')}`);
});

test('the loader returns the driver once and keeps it for the next call', async () => {
  const { loadPlaywright } = await import('../src/playwright-driver.js');
  const first = await loadPlaywright();
  assert.equal(typeof first.chromium, 'object', 'the patched Chromium is reachable from the loaded driver');
  assert.equal(await loadPlaywright(), first, 'a second call reuses the same module');
});
