import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, backendCredentialRef } from '@nite07/search-core';
import { loadConfig } from '../src/config.js';
import { fixedSource, watchSource } from '../src/live.js';
import { createManageTool } from '../src/manage.js';
import { saveConfig, saveCredential, snapshot } from '../src/ui/state.js';

const signal = () => new AbortController().signal;
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'wsm-manage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify({ search: defaultConfig(), credentials: { browser: 'private-sentinel' }, compactByDefault: false }));
  const source = fixedSource(await loadConfig({ configPath: path }));
  return { path, source, tool: createManageTool(source) };
}

test('settings omits values; complete save reloads source and notifies exposure listeners', async t => {
  const { tool, source } = await fixture(t);
  let notifications = 0;
  source.subscribe!(() => notifications++);
  const before = await tool.call({ action: 'settings' }, signal()) as any;
  assert.doesNotMatch(JSON.stringify(before), /private-sentinel/);
  assert.equal(before.browser.source, 'file');
  const config = structuredClone(before.config);
  config.tools.webExtract = !config.tools.webExtract;
  const result = await tool.call({ action: 'save', config, expectedRevision: before.revision, compactByDefault: true }, signal()) as any;
  assert.equal(result.saved, true);
  assert.equal(source.get().search.tools.webExtract, config.tools.webExtract);
  assert.equal(source.get().compactByDefault, true);
  assert.equal(notifications, 1);
  assert.notEqual(source.revision(), 'fixed');
  await assert.rejects(tool.call({ action: 'save', config, expectedRevision: before.revision }, signal()), /changed/);
});

test('strict action validation rejects patches, extra fields and malformed calls without leakage', async t => {
  const { tool, path } = await fixture(t);
  const before = await readFile(path, 'utf8');
  const calls = [
    { action: 'settings', configPath: '/tmp/evil' },
    { action: 'save', config: defaultConfig() },
    { action: 'save', config: { 'secret-field-sentinel': 'private-sentinel' }, expectedRevision: 'missing' },
    { action: 'save', config: defaultConfig(), expectedRevision: 'missing', compactByDefault: 'true' },
    { action: 'credential', scope: 'backend', backendId: 'private-sentinel', value: 'private-sentinel', expectedRevision: 'missing' },
    { action: 'credential', scope: 'browser', value: 'private-sentinel', remove: true, expectedRevision: 'missing' },
    { action: 'fetch-test', url: 'https://example.com' },
    { action: 'test', backendId: 'brave', query: 'hello', maxResults: 6 },
    { action: 'test', backendId: 'brave', query: 'hello' },
  ];
  for (const args of calls) {
    await assert.rejects(tool.call(args, signal()), error => {
      assert.doesNotMatch(String(error), /private-sentinel|secret-field-sentinel/);
      return true;
    });
  }
  assert.equal(await readFile(path, 'utf8'), before);
});

test('credential writes require revision, reload immediately and preserve env precedence after removal', async t => {
  const { tool, source } = await fixture(t);
  const ref = backendCredentialRef('brave');
  const old = process.env[ref];
  process.env[ref] = 'environment-sentinel';
  t.after(async () => { if (old === undefined) delete process.env[ref]; else process.env[ref] = old; });
  let settings = await tool.call({ action: 'settings' }, signal()) as any;
  await assert.rejects(tool.call({ action: 'credential', scope: 'browser', value: 'value' }, signal()), /expectedRevision/);
  const added = await tool.call({ action: 'credential', scope: 'backend', backendId: 'brave', value: 'new-secret-sentinel', expectedRevision: settings.revision }, signal()) as any;
  assert.equal(source.get().credentials.brave, 'new-secret-sentinel');
  assert.equal(added.state.source, 'env');
  assert.doesNotMatch(JSON.stringify(added), /new-secret-sentinel|environment-sentinel/);
  await assert.rejects(tool.call({ action: 'credential', scope: 'backend', backendId: 'brave', remove: true, expectedRevision: settings.revision }, signal()), /changed/);
  settings = await tool.call({ action: 'settings' }, signal()) as any;
  const removed = await tool.call({ action: 'credential', scope: 'backend', backendId: 'brave', remove: true, expectedRevision: settings.revision }, signal()) as any;
  assert.equal(removed.state.source, 'env');
  assert.equal(removed.state.length, 0);
  assert.equal(source.get().credentials.brave, undefined);
});

test('UI and tool writers serialize revision checks across config and credential changes', async t => {
  const { path } = await fixture(t);
  const before = await snapshot(path);
  const results = await Promise.allSettled([
    saveConfig(path, { config: { ...before.config, maxResults: 7 }, expectedRevision: before.revision }),
    saveCredential(path, { scope: 'browser', value: 'concurrent-secret', expectedRevision: before.revision }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const after = await snapshot(path);
  assert.notEqual(after.revision, before.revision);
  // Backward-compatible UI calls without a revision still serialize and preserve other fields.
  await Promise.all([
    saveConfig(path, { config: { ...after.config, maxResults: 9 } }),
    saveCredential(path, { scope: 'browser', value: 'second-secret' }),
  ]);
  const config = await loadConfig({ configPath: path });
  assert.equal(config.search.maxResults, 9);
  assert.equal(config.credentials.browser, 'second-secret');
});

test('invalid JSON and validation errors never disclose raw stored values', async t => {
  const { tool, path } = await fixture(t);
  await writeFile(path, '{"credentials":{"browser":"parse-secret-sentinel"}, invalid');
  const settings = await tool.call({ action: 'settings' }, signal()) as any;
  assert.doesNotMatch(JSON.stringify(settings), /parse-secret-sentinel/);
  await assert.rejects(tool.call({ action: 'save', config: defaultConfig(), expectedRevision: settings.revision }, signal()), error => {
    assert.doesNotMatch(JSON.stringify(error), /parse-secret-sentinel/);
    return true;
  });
  await writeFile(path, JSON.stringify({ search: { 'invalid-secret-key': 'secret-value' } }));
  assert.doesNotMatch(JSON.stringify(await tool.call({ action: 'settings' }, signal())), /invalid-secret-key|secret-value/);
});

test('network-free test actions use saved configuration and signal, omitting untrusted provider content', async t => {
  const { path, source } = await fixture(t);
  const config = source.get().search;
  config.backends.brave!.enabled = true;
  await saveConfig(path, { config });
  let called = 0;
  let searchOk = false;
  const tool = createManageTool(source, {
    search: saved => {
      assert.equal(saved.search.backends.brave!.enabled, true);
      return { search: async (input, receivedSignal, onlyBackend) => {
        called++;
        assert.equal(input.maxResults, 3);
        assert.equal(onlyBackend, 'brave');
        assert.equal(receivedSignal?.aborted, false);
        return { sources: [{ url: 'https://example.com/private-sentinel' }], content: 'private-sentinel', truncated: false, cached: false, outcomes: [{ backend: 'brave', mode: 'key', ok: searchOk, attempts: 1, durationMs: 1, sources: [], warnings: ['private-sentinel'], error: { kind: 'authentication', message: 'private-sentinel' } }] };
      } };
    },
    fetch: () => ({ fetchPage: async (input, receivedSignal) => {
      called++;
      assert.equal(input.format, 'html');
      assert.equal(receivedSignal?.aborted, false);
      return { requestedUrl: input.url, format: input.format, content: 'private-sentinel', ok: true, stopReason: 'accepted', truncated: false, attempts: [], notes: ['private-sentinel'] };
    } }),
  });
  const search = await tool.call({ action: 'test', backendId: 'brave', query: 'hello', maxResults: 3 }, signal());
  assert.deepEqual(search, { ok: false, backendId: 'brave', sourceCount: 1, attempts: 1, failure: { kind: 'authentication' } });
  const fetched = await tool.call({ action: 'fetch-test', url: 'https://example.com', format: 'html' }, signal());
  assert.doesNotMatch(JSON.stringify(fetched), /private-sentinel/);
  assert.equal((fetched as { ok: boolean }).ok, true);
  searchOk = true;
  const successful = await tool.call({ action: 'test', backendId: 'brave', query: 'hello', maxResults: 3 }, signal());
  assert.equal((successful as { ok: boolean }).ok, true);
  assert.doesNotMatch(JSON.stringify(successful), /private-sentinel/);
  assert.equal(called, 3);
  const failed = createManageTool(source, { search: () => { throw new Error('private-sentinel'); } });
  await assert.rejects(failed.call({ action: 'test', backendId: 'brave', query: 'hello' }, signal()), error => {
    assert.doesNotMatch(String(error), /private-sentinel/);
    return true;
  });
});

test('aborted operations do not mutate; explicit watched reload propagates failure and retains last good state', async t => {
  const { tool, path } = await fixture(t);
  const before = await readFile(path, 'utf8');
  const controller = new AbortController();
  controller.abort(new Error('abort-secret-sentinel'));
  await assert.rejects(tool.call({ action: 'credential', scope: 'browser', value: 'secret', expectedRevision: (await snapshot(path)).revision }, controller.signal), error => {
    assert.doesNotMatch(String(error), /abort-secret-sentinel/);
    return true;
  });
  assert.equal(await readFile(path, 'utf8'), before);
  const source = watchSource(await loadConfig({ configPath: path }), () => undefined);
  t.after(async () => source.close());
  await writeFile(path, 'not json');
  await assert.rejects(source.reload!());
  assert.equal(source.get().credentials.browser, 'private-sentinel');
  await writeFile(path, JSON.stringify({ search: { ...defaultConfig(), maxResults: 17 } }));
  await source.reload!();
  assert.equal(source.get().search.maxResults, 17);
});
