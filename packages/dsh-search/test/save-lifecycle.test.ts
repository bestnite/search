import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boot, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot';
import { defaultConfig, parseConfig, revision } from '@nite07/search-core';
import type { SearchConfig } from '@nite07/search-core';

/**
 * The save path against the real DSH configuration lifecycle, not a stub.
 *
 * `configEditor.edit()` writes the profile patch, the Loader restarts the plugin with the new raw
 * config, and the settings page then reads the running instance back. The stub used by
 * `settings.test.ts` cannot show the last step, and the live page reported the false conflict
 * ("Saved configuration differs from your draft") that only appears when those two shapes differ.
 *
 * Each test boots a throwaway profile: a bundle whose insert holds the saved row, an empty root
 * include, and a fake `profileContext` plus fake host services. Nothing touches the operator's
 * profile, credentials or network.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const pluginEntry = pathToFileURL(join(here, '..', 'src', 'index.ts')).href;
const bareModuleBaseUrl = pathToFileURL(join(here, '..', 'src', 'client.tsx')).href;

interface App {
  dir: string;
  routes: Map<string, any>;
  applies: () => number;
  tools: Map<string, any>;
  snapshot: () => Promise<any>;
  save: (body: unknown) => Promise<{ status: number; body: any }>;
  dispose: () => Promise<void>;
}

/** A saved row from an older release: it predates the page-fetch block and per-provider fetch rows. */
function legacySavedConfig(): any {
  const config: any = defaultConfig();
  delete config.pageFetch;
  for (const row of Object.values(config.backends) as any[]) delete row.fetch;
  return config;
}

async function bootProfile(saved: unknown): Promise<App> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-save-lifecycle-'));
  const bundleDir = join(dir, 'node_modules', 'lifecycle-bundle');
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, 'package.json'), JSON.stringify({ name: 'lifecycle-bundle', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  // JSON is valid YAML, so the fixture needs no serializer: one insert row holds the plugin rows.
  await writeFile(join(bundleDir, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: '@deepseek-ai/dsh-config-editor' },
    { id: 'nite-search', name: pluginEntry, config: saved },
  ] }]));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'lifecycle-profile', private: true, dsh: { profile: { bundles: ['lifecycle-bundle'] } } }, null, 2));
  await writeFile(join(dir, 'cordis.yml'), '[]\n');
  const home = join(dir, 'home');
  await mkdir(home, { recursive: true });
  const profileContext = { name: 'lifecycle', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(dir, 'package.json'), cwd: dir, home, startedBundles: ['lifecycle-bundle'], overlays: [], telemetryDisabledEnv: undefined };
  const loaded = loadProfileDirectory('dsh', dir, profileContext.installAnchor);
  const routes = new Map<string, any>();
  const tools = new Map<string, any>();
  const records = new Map();
  let applies = 0;
  const table = { get: (key: string) => records.get(key), entries: () => records.entries(), put: async (key: string, value: unknown) => { records.set(key, value); } };
  const ctx = await boot('dsh', join(dir, 'cordis.yml'), [...loaded.layers.flatMap(layer => layer.patches), ...loaded.patches], (root: any) => {
    root.provide('profileContext', profileContext);
    root.provide('web', { registerSearchProvider: () => () => undefined });
    root.provide('credentials', { resolve: async () => undefined, describe: async () => ({ configured: false, writable: true }), set: async () => undefined, unset: async () => undefined });
    root.provide('tools', { register: (definition: any) => { tools.set(definition.name, definition); return () => undefined; } });
    root.provide('connection', { fetch: { register: (route: any) => { applies += 1; routes.set(route.path, route); return async () => { if (routes.get(route.path) === route) routes.delete(route.path); }; } } });
    root.provide('storageDomain', { open: async () => ({ table: () => table, close: async () => undefined }) });
  }, bareModuleBaseUrl);
  const route = (path: string): any => {
    const live = routes.get(path);
    assert.ok(live, `the plugin registered ${path}`);
    return live;
  };
  return {
    dir, routes,
    applies: () => applies,
    tools,
    snapshot: async () => (await route('/api/nite-search/settings').fetch(new Request('https://localhost/api/nite-search/settings'))).json(),
    save: async (body: unknown) => {
      const response = await route('/api/nite-search/settings').fetch(new Request('https://localhost/api/nite-search/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      return { status: response.status, body: await response.json() };
    },
    dispose: async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('a configuration saved before the page-fetch block existed saves on the first attempt', async () => {
  const app = await bootProfile(legacySavedConfig());
  try {
    const before = await app.snapshot();
    assert.equal(before.config.maxResults, 8);
    assert.ok(before.config.pageFetch, 'the served configuration carries the migrated page-fetch block');
    // The saved row is still the old shape here, so the running revision and the row revision are two
    // key orders of one configuration. They must not read as a conflict.
    const intended: SearchConfig = structuredClone(before.config);
    intended.maxResults = 23;
    const saved = await app.save({ config: intended, expectedRevision: before.revision });
    assert.equal(saved.status, 200, `the first save is accepted: ${JSON.stringify(saved.body)}`);
    assert.equal(saved.body.saved, true);
    assert.equal(saved.body.revision, revision(parseConfig(intended)), 'the answer names the revision of the written configuration');

    const after = await app.snapshot();
    assert.equal(after.config.maxResults, 23);
    assert.equal(after.revision, saved.body.revision, 'the read-back is the configuration that was written');
    assert.deepEqual(after.config, parseConfig(intended), 'the read-back holds exactly the saved values');
    assert.ok(app.applies() > 3, 'the plugin restarted, so the running instance is the new configuration');

    // The written row is complete, so a fresh boot of the same profile keeps the saved values.
    const savedText = await readFile(join(app.dir, 'cordis.patch.yml'), 'utf8');
    assert.match(savedText, /pageFetch:/, 'the written row carries the migrated block');
    const second = await bootsAgain(app.dir, intended);
    assert.equal(second.config.maxResults, 23, 'a reload of the profile keeps the saved value');
    assert.equal(second.revision, saved.body.revision, 'a reload reports the same revision as the save');
  } finally {
    await app.dispose();
  }
});

/** Read the saved configuration back through a second application instance over the same profile. */
async function bootsAgain(dir: string, expected: SearchConfig): Promise<any> {
  const profileContext = { name: 'lifecycle', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(dir, 'package.json'), cwd: dir, home: join(dir, 'home'), startedBundles: ['lifecycle-bundle'], overlays: [], telemetryDisabledEnv: undefined };
  const loaded = loadProfileDirectory('dsh', dir, profileContext.installAnchor);
  const routes = new Map<string, any>();
  const records = new Map();
  const table = { get: (key: string) => records.get(key), entries: () => records.entries(), put: async (key: string, value: unknown) => { records.set(key, value); } };
  const ctx = await boot('dsh', join(dir, 'cordis.yml'), [...loaded.layers.flatMap(layer => layer.patches), ...loaded.patches], (root: any) => {
    root.provide('profileContext', profileContext);
    root.provide('web', { registerSearchProvider: () => () => undefined });
    root.provide('credentials', { resolve: async () => undefined, describe: async () => ({ configured: false, writable: true }), set: async () => undefined, unset: async () => undefined });
    root.provide('tools', { register: () => () => undefined });
    root.provide('connection', { fetch: { register: (route: any) => { routes.set(route.path, route); return async () => undefined; } } });
    root.provide('storageDomain', { open: async () => ({ table: () => table, close: async () => undefined }) });
  }, bareModuleBaseUrl);
  try {
    const live = routes.get('/api/nite-search/settings');
    assert.ok(live, 'the reloaded profile serves the settings route');
    const snapshot = await (await live.fetch(new Request('https://localhost/api/nite-search/settings'))).json();
    assert.equal(snapshot.config.maxResults, expected.maxResults);
    return snapshot;
  } finally {
    await ctx.fiber.dispose();
  }
}

test('the same values under a different key order keep one revision and save cleanly', async () => {
  const base = parseConfig(defaultConfig());
  const reordered: any = {};
  for (const key of Object.keys(base).reverse()) reordered[key] = (base as any)[key];
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(base), 'the fixture really is a different key order');
  assert.equal(revision(reordered), revision(base), 'one configuration has one revision');
  assert.deepEqual(parseConfig(reordered), base, 'the normalized shape is the same configuration');

  const app = await bootProfile(reordered);
  try {
    const before = await app.snapshot();
    const intended: SearchConfig = structuredClone(before.config);
    intended.concurrency = 7;
    const saved = await app.save({ config: intended, expectedRevision: before.revision });
    assert.equal(saved.status, 200, 'a reordered saved row is not a concurrent edit');
    const after = await app.snapshot();
    assert.equal(after.config.concurrency, 7);
  } finally {
    await app.dispose();
  }
});

test('a changed value still conflicts, so a real concurrent edit is never reported as saved', async () => {
  const app = await bootProfile(defaultConfig());
  try {
    const before = await app.snapshot();
    const first: SearchConfig = structuredClone(before.config);
    first.maxResults = 17;
    assert.equal((await app.save({ config: first, expectedRevision: before.revision })).status, 200);
    const stale: SearchConfig = structuredClone(before.config);
    stale.maxResults = 19;
    const late = await app.save({ config: stale, expectedRevision: before.revision });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'revision-conflict');
    const current = await app.snapshot();
    assert.equal(current.config.maxResults, 17, 'the earlier save stays saved');
    assert.equal(current.revision, revision(parseConfig(first)), 'the served revision follows the saved row');
  } finally {
    await app.dispose();
  }
});
