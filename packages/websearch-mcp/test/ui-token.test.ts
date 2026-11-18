import test from 'node:test';
import assert from 'node:assert/strict';
import { decideToken, tokenIsShort } from '../src/ui/token.js';

test('no flag and no environment means an open page', () => {
  const decision = decideToken({ env: {} });
  assert.equal(decision.token, undefined);
  assert.equal(decision.source, 'none');
  assert.match(decision.note, /open/);
});

test('--no-token wins over everything', () => {
  const decision = decideToken({ open: true, flag: 'from-flag', env: { WEBSEARCH_MCP_UI_TOKEN: 'from-env' } });
  assert.equal(decision.token, undefined);
  assert.match(decision.note, /--no-token/);
});

test('--token beats the environment', () => {
  assert.deepEqual(
    decideToken({ flag: 'from-flag', env: { WEBSEARCH_MCP_UI_TOKEN: 'from-env' } }).source,
    'flag',
  );
  assert.equal(decideToken({ flag: 'from-flag', env: { WEBSEARCH_MCP_UI_TOKEN: 'from-env' } }).token, 'from-flag');
  assert.equal(decideToken({ env: { WEBSEARCH_MCP_UI_TOKEN: 'from-env' } }).token, 'from-env');
});

test('a blank value counts as unset', () => {
  assert.equal(decideToken({ flag: '   ', env: { WEBSEARCH_MCP_UI_TOKEN: '  ' } }).source, 'none');
});

test('short tokens are flagged, nothing is ever written', () => {
  assert.equal(tokenIsShort('abc'), true);
  assert.equal(tokenIsShort('a'.repeat(16)), false);
  assert.equal('persist' in decideToken({ flag: 'x' }), false, 'the decision has nothing to save');
});
