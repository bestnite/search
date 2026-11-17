import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, credentialResolver, describeBackends, enabledBackendIds, loadConfig, starterConfig } from '../src/config.js';
import { backendCredentialRef, browserCredentialRef, defaultConfig } from '@nite07/search-core';

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

test('credential values are literal and cannot reference arbitrary environment variables', async () => {
  const search = defaultConfig();
  search.backends.searxng!.enabled = true;
  const path = await writeTemp({ search, credentials: { searxng: '${MY_SERPER_KEY}' } });
  const config = await loadConfig({ configPath: path, env: { MY_SERPER_KEY: 'expanded-value' } });
  assert.equal(config.credentials.searxng, '${MY_SERPER_KEY}');
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
  const resolve = credentialResolver(config, { [backendCredentialRef('keenable')]: 'from-env' } as NodeJS.ProcessEnv);
  assert.equal(await resolve(backendCredentialRef('keenable')), 'from-env');
  const noEnv = credentialResolver(config, {} as NodeJS.ProcessEnv);
  assert.equal(await noEnv(backendCredentialRef('keenable')), 'from-file');
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


test('legacy names are discarded and browser tokens use one fixed destination', async () => {
 const search:any=defaultConfig();search.browser.credentialRef='UNRELATED';search.backends.xiaohongshu.credentialRef='OTHER';
 const config=await loadConfig({configPath:await writeTemp({search,credentials:{browser:'file-token',xiaohongshu:'wrong-token'}}),env:{}});
 assert.equal('credentialRef' in config.search.browser,false);assert.equal('credentialRef' in config.search.backends.xiaohongshu!,false);
 const resolve=credentialResolver(config,{DSH_SEARCH_BROWSER_TOKEN:'env-token',UNRELATED:'secret',OTHER:'secret'});
 assert.equal(await resolve(browserCredentialRef()),'env-token');assert.equal(await resolve('UNRELATED'),undefined);assert.equal(await resolve(backendCredentialRef('xiaohongshu')),undefined);
 assert.equal(await credentialResolver(config,{})(browserCredentialRef()),'file-token');
 const row=describeBackends(config,{}).find(row=>row.id==='xiaohongshu')!;assert.equal(row.requiresCredential,false);assert.equal(row.credentialPresent,true);
 config.credentials={xiaohongshu:'wrong-token'};assert.equal(describeBackends(config,{}).find(row=>row.id==='xiaohongshu')!.credentialPresent,false);
});

test('the shipped example loads against the current core',async()=>{
 const config=await loadConfig({configPath:new URL('../config.example.json',import.meta.url).pathname,env:{}});
 assert.deepEqual(enabledBackendIds(config),['keenable','reddit']);
});
