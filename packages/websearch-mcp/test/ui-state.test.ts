import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '@nite07/search-core';
import { SettingsError, companionPath, containerVariant, saveConfig, saveCredential, snapshot } from '../src/ui/state.js';

async function workspace(body?: unknown): Promise<{ path: string; text: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'wsm-ui-'));
  const path = join(directory, 'config.json');
  const search = defaultConfig();
  const text = `${JSON.stringify(body ?? { search, credentials: {}, compactByDefault: false }, null, 2)}\n`;
  await writeFile(path, text, 'utf8');
  return { path, text };
}

test('an invalid configuration is rejected before the file is touched', async () => {
  const { path, text } = await workspace();
  const search = defaultConfig();
  search.maxResults = 999;
  await assert.rejects(saveConfig(path, { config: search }), (error: unknown) => {
    assert.ok(error instanceof SettingsError);
    assert.equal(error.status, 400);
    assert.ok(error.issues.some(issue => issue.path === 'maxResults'));
    return true;
  });
  assert.equal(await readFile(path, 'utf8'), text, 'the file is byte-identical after a rejected save');
});

test('a stale expectedRevision is a conflict, not a silent overwrite', async () => {
  const { path } = await workspace();
  await assert.rejects(saveConfig(path, { config: defaultConfig(), expectedRevision: 'stale' }), (error: unknown) => {
    assert.ok(error instanceof SettingsError);
    assert.equal(error.status, 409);
    return true;
  });
});

test('a valid save keeps credentials, unknown keys and a backup', async () => {
  const search = defaultConfig();
  const { path } = await workspace({ search, credentials: { exa: 'secret-value' }, compactByDefault: false, custom: { keep: true } });
  const next = defaultConfig();
  next.mode = 'single';
  next.singleBackend = 'reddit';
  next.backends.reddit!.enabled = true;
  const saved = await saveConfig(path, { config: next, compactByDefault: true });
  const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  assert.equal((written.search as { mode: string }).mode, 'single');
  assert.deepEqual(written.credentials, { exa: 'secret-value' });
  assert.equal(written.compactByDefault, true);
  assert.deepEqual(written.custom, { keep: true });
  assert.ok(saved.backup && saved.backup.includes('.bak-'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('backups rotate instead of growing without bound', async () => {
  const { path } = await workspace();
  for (let index = 0; index < 8; index += 1) {
    const next = defaultConfig();
    next.maxResults = 5 + index;
    await saveConfig(path, { config: next });
  }
  const backups = (await readdir(join(path, '..'))).filter(name => name.startsWith('config.json.bak-'));
  assert.ok(backups.length <= 5, `expected at most 5 backups, found ${backups.length}`);
});

test('credentials are written and cleared without ever being read back', async () => {
  const { path } = await workspace();
  const saved = await saveCredential(path, { scope: 'backend', id: 'exa', value: '  a-very-secret-key  ' });
  assert.equal(saved.state.source, 'file');
  assert.equal(saved.state.length, 'a-very-secret-key'.length);
  const json = JSON.stringify(await snapshot(path, {}));
  assert.equal(json.includes('a-very-secret-key'), false, 'the value never appears in a snapshot');

  const browser = await saveCredential(path, { scope: 'browser', id: undefined, value: 'endpoint-token' });
  assert.equal(browser.state.id, 'browser');
  const cleared = await saveCredential(path, { scope: 'browser', id: undefined, remove: true });
  assert.equal(cleared.state.source, 'none');
  const written = JSON.parse(await readFile(path, 'utf8')) as { credentials: Record<string, string> };
  assert.deepEqual(Object.keys(written.credentials), ['exa']);
});

test('an empty or unknown credential is refused', async () => {
  const { path } = await workspace();
  await assert.rejects(saveCredential(path, { scope: 'backend', id: 'exa', value: '   ' }), SettingsError);
  await assert.rejects(saveCredential(path, { scope: 'backend', id: 'nope', value: 'x' }), SettingsError);
});

test('an environment value is reported as the source and wins', async () => {
  const { path } = await workspace({ search: defaultConfig(), credentials: { exa: 'from-file' } });
  const current = await snapshot(path, { DSH_SEARCH_EXA_KEY: 'from-env' });
  const exa = current.credentials.find(item => item.id === 'exa')!;
  assert.equal(exa.source, 'env');
  assert.equal(exa.length, 'from-file'.length, 'the file length is still reported, the env value is not');
});

test('an unparseable file still opens the page on defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wsm-ui-'));
  const path = join(directory, 'config.json');
  await writeFile(path, '{ not json', 'utf8');
  const current = await snapshot(path);
  assert.ok(current.loadError);
  assert.equal(current.config.mode, defaultConfig().mode);
});

test('a container copy rewrites loopback endpoints and keeps everything else', () => {
  const search = defaultConfig();
  search.browser.endpoint = 'ws://127.0.0.1:3030/ws';
  search.backends.searxng!.enabled = true;
  search.backends.searxng!.endpoint = 'http://127.0.0.1:8385/search';
  search.backends.exa!.endpoint = 'https://mcp.exa.ai/mcp';
  const copy = containerVariant(search);
  assert.equal(copy.browser.endpoint, 'ws://host.containers.internal:3030/ws');
  assert.equal(copy.backends.searxng!.endpoint, 'http://host.containers.internal:8385/search');
  assert.equal(copy.backends.exa!.endpoint, 'https://mcp.exa.ai/mcp', 'a public endpoint is untouched');
  assert.equal(search.browser.endpoint, 'ws://127.0.0.1:3030/ws', 'the source object is not mutated');
});

test('the browser session file is mapped into the container home mount', () => {
  const home = '/home/tester';
  const empty = defaultConfig();
  assert.equal(containerVariant(empty, home).browser.statePath, '/host/home/.config/dsh-search/browser/state.json');

  const explicit = defaultConfig();
  explicit.browser.statePath = `${home}/pod/search-browser/data/state.json`;
  assert.equal(containerVariant(explicit, home).browser.statePath, '/host/home/pod/search-browser/data/state.json');

  const outside = defaultConfig();
  outside.browser.statePath = '/var/lib/search/state.json';
  assert.equal(containerVariant(outside, home).browser.statePath, '/var/lib/search/state.json', 'a path outside home is left alone');
});

test('an existing companion is refreshed on save, and no companion is invented', async () => {
  const { path } = await workspace({ search: defaultConfig(), credentials: { exa: 'k' } });
  const companion = companionPath(path);
  const next = defaultConfig();
  next.browser.endpoint = 'ws://127.0.0.1:3030/ws';
  await saveConfig(path, { config: next });
  await assert.rejects(readFile(companion, 'utf8'), /ENOENT/, 'without a companion nothing is created');

  await writeFile(companion, '{"search":{},"credentials":{},"compactByDefault":false}\n');
  await saveConfig(path, { config: next, compactByDefault: true });
  const written = JSON.parse(await readFile(companion, 'utf8')) as { search: { browser: { endpoint: string } }; credentials: Record<string, string> };
  assert.equal(written.search.browser.endpoint, 'ws://host.containers.internal:3030/ws');
  assert.deepEqual(written.credentials, { exa: 'k' }, 'the companion carries the same credentials');
  assert.equal((await stat(companion)).mode & 0o777, 0o600);

  const current = await snapshot(path);
  assert.equal(current.companion.active, true);
  await saveCredential(path, { scope: 'backend', id: 'x', value: 'token' });
  const afterCredential = JSON.parse(await readFile(companion, 'utf8')) as { credentials: Record<string, string> };
  assert.equal(afterCredential.credentials.x, 'token', 'a credential change reaches the companion too');
});
