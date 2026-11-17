import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, credentialResolver, describeBackends, enabledBackendIds, loadConfig, starterConfig } from '../src/config.js';
import { defaultConfig } from '@nite07/search-core';

const writeTemp = async (body: unknown): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'websearch-mcp-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(body), 'utf8');
  return path;
};

test('a missing file explains exactly what to create', async () => {
  await assert.rejects(loadConfig({ configPath: '/nonexistent/config.json' }), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /No configuration file/);
    assert.ok(error.details.some(detail => detail.includes('--print-config')));
    return true;
  });
});

test('the starter config is itself valid', async () => {
  const path = await writeTemp(starterConfig());
  const config = await loadConfig({ configPath: path, env: {} });
  assert.equal(config.search.mode, defaultConfig().mode);
  assert.equal(enabledBackendIds(config).length, 0, 'nothing is enabled by default');
  assert.equal(config.compactByDefault, false);
});

test('credential references expand from the environment', async () => {
  const search = defaultConfig();
  search.backends.searxng!.enabled = true;
  const path = await writeTemp({ search, credentials: { searxng: '${MY_SERPER_KEY}' } });
  const config = await loadConfig({ configPath: path, env: { MY_SERPER_KEY: 'expanded-value' } });
  assert.equal(config.credentials.searxng, 'expanded-value');
});

test('an invalid configuration lists every issue', async () => {
  const search = JSON.parse(JSON.stringify(defaultConfig()));
  search.mode = 'nonsense';
  const path = await writeTemp({ search });
  await assert.rejects(loadConfig({ configPath: path, env: {} }), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.ok(error.details.some(detail => detail.startsWith('mode:')));
    return true;
  });
});

test('credentials resolve from the environment before the file', async () => {
  const search = defaultConfig();
  const config = { search, credentials: { keenable: 'from-file' }, compactByDefault: false, configPath: 'x' };
  const resolve = credentialResolver(config, { [search.backends.keenable!.credentialRef]: 'from-env' } as NodeJS.ProcessEnv);
  assert.equal(await resolve(search.backends.keenable!.credentialRef), 'from-env');
  const noEnv = credentialResolver(config, {} as NodeJS.ProcessEnv);
  assert.equal(await noEnv(search.backends.keenable!.credentialRef), 'from-file');
  assert.equal(await noEnv('SOMETHING_UNKNOWN'), undefined);
});

test('backend descriptions carry mode, tier and credential state', async () => {
  const search = defaultConfig();
  search.backends.reddit!.enabled = true;
  const rows = describeBackends({ search, credentials: {}, compactByDefault: false, configPath: 'x' }, {} as NodeJS.ProcessEnv);
  const reddit = rows.find(row => row.id === 'reddit')!;
  assert.equal(reddit.enabled, true);
  assert.equal(reddit.requiresCredential, false, 'it defaults to anonymous');
  assert.deepEqual((reddit.modes as Array<{ mode: string }>).map(mode => mode.mode), ['anonymous', 'oauth']);
});
