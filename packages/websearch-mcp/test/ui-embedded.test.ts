import test from 'node:test';
import assert from 'node:assert/strict';
import { embeddedFromEnv, resolveEmbeddedUi } from '../src/ui/embedded.js';

test('no port means the stdio process serves nothing extra', () => {
  assert.deepEqual(resolveEmbeddedUi({}), {});
  assert.deepEqual(embeddedFromEnv({}), {});
  assert.deepEqual(resolveEmbeddedUi({ port: '  ' }), {});
});

test('a port turns the page on, on loopback by default', () => {
  assert.deepEqual(embeddedFromEnv({ WEBSEARCH_MCP_UI_PORT: '7799' }), { target: { host: '127.0.0.1', port: 7799 } });
  assert.deepEqual(
    embeddedFromEnv({ WEBSEARCH_MCP_UI_PORT: '7799', WEBSEARCH_MCP_UI_HOST: '0.0.0.0' }),
    { target: { host: '0.0.0.0', port: 7799 } },
  );
  assert.deepEqual(embeddedFromEnv({ WEBSEARCH_MCP_UI_PORT: '0' }), { target: { host: '127.0.0.1', port: 0 } }, 'zero asks the OS for a free port');
});

test('a bad port is reported instead of guessed', () => {
  for (const port of ['abc', '70000', '-1', '7799.5']) {
    const decision = resolveEmbeddedUi({ port });
    assert.equal(decision.target, undefined);
    assert.match(decision.error ?? '', /not a port number/);
  }
});
