import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '@nite07/search-core';
import { asSource, fixedSource, watchSource } from '../src/live.js';
import { loadConfig } from '../src/config.js';

async function write(path: string, body: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

const body = (maxResults: number) => ({ search: { ...defaultConfig(), maxResults }, credentials: {}, compactByDefault: false });

async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('the watcher did not report a change in time');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('a plain config object is wrapped and never changes revision', () => {
  const config = { search: defaultConfig(), credentials: {}, compactByDefault: false, configPath: '/tmp/x.json' };
  const source = asSource(config);
  assert.equal(source.get(), config);
  assert.equal(source.revision(), source.revision());
  assert.equal(asSource(fixedSource(config)).revision(), 'fixed');
});

test('a write on disk reaches the source without a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wsm-live-'));
  const path = join(directory, 'config.json');
  await write(path, body(8));
  const initial = await loadConfig({ configPath: path });
  const log: string[] = [];
  const source = watchSource(initial, message => log.push(message));
  try {
    assert.equal(source.get().search.maxResults, 8);
    const before = source.revision();
    await write(path, body(17));
    await until(() => source.revision() !== before);
    assert.equal(source.get().search.maxResults, 17);
  } finally {
    source.close();
  }
});

test('a broken write keeps the last working configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wsm-live-'));
  const path = join(directory, 'config.json');
  await write(path, body(9));
  const log: string[] = [];
  const source = watchSource(await loadConfig({ configPath: path }), message => log.push(message));
  try {
    const before = source.revision();
    await writeFile(path, '{ this is not json', 'utf8');
    await until(() => log.some(line => line.includes('not usable')));
    assert.equal(source.get().search.maxResults, 9);
    assert.equal(source.revision(), before);
  } finally {
    source.close();
  }
});
