import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '@nite07/search-core';
import { xhsBrowserRead } from '../src/browser-read.js';

const signal = new AbortController().signal;

test('a direct note read carries the shared per-site cap so it joins the search session', () => {
  const config = defaultConfig();
  config.browser.endpoint = 'ws://127.0.0.1:3000/ws';
  config.browser.maxConcurrentReads = 3;
  const read = xhsBrowserRead(config, 'ENDPOINT_TOKEN', signal);
  assert.equal(read.maxConcurrentReads, 3, 'the cap is part of the session identity, so the tool must pass it');
  assert.equal(read.wsEndpoint, config.browser.endpoint);
  assert.equal(read.token, 'ENDPOINT_TOKEN');
  assert.equal(read.timeoutMs, config.browser.timeoutMs);
  assert.equal(read.signal, signal);
});

test('the same read context applies the shared browser precedence that search applies', () => {
  const config = defaultConfig();
  config.browser.endpoint = 'ws://shared:3000/ws';
  config.browser.statePath = '/shared/state.json';
  config.backends.xiaohongshu!.endpoint = 'ws://backend:3000/ws';
  config.backends.xiaohongshu!.options.statePath = '/backend/state.json';
  const shared = xhsBrowserRead(config, undefined, signal);
  assert.equal(shared.wsEndpoint, 'ws://shared:3000/ws', 'the shared endpoint wins over the backend one');
  assert.equal(shared.statePath, '/backend/state.json', 'a per-backend session file wins, exactly as the search adapter resolves it');
  assert.equal('token' in shared, false, 'a missing endpoint token is omitted, not stored as undefined');

  config.browser.endpoint = '';
  config.backends.xiaohongshu!.options.statePath = '';
  const fallback = xhsBrowserRead(config, undefined, signal);
  assert.equal(fallback.wsEndpoint, 'ws://backend:3000/ws', "the backend's own endpoint is only a fallback");
  assert.equal(fallback.statePath, '/shared/state.json', 'an empty backend override falls back to the shared session file');
  assert.equal(fallback.maxConcurrentReads, 2, 'a default configuration reads at the conservative default');

  config.browser.statePath = '';
  assert.equal('statePath' in xhsBrowserRead(config, undefined, signal), false, 'an empty session path is omitted rather than saved as an empty string');
});

test('a missing endpoint is refused before any browser work', () => {
  const config = defaultConfig();
  config.browser.endpoint = '';
  config.backends.xiaohongshu!.endpoint = '';
  assert.throws(() => xhsBrowserRead(config, undefined, signal), /No browser endpoint is configured/);
});
