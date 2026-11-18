import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideToken, tokenIsShort, writeTokenFile } from '../src/ui/token.js';

const tmp = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), 'wsm-token-')), 'ui-token');

test('an unset token means no authentication, and nothing is minted', async () => {
  const tokenFile = await tmp();
  const decision = await decideToken({ tokenFile });
  assert.equal(decision.token, undefined);
  assert.equal(decision.source, 'none');
  await assert.rejects(readFile(tokenFile, 'utf8'), /ENOENT/, 'the file is not created behind the caller');
});

test('--no-token wins over a saved token', async () => {
  const tokenFile = await tmp();
  await writeTokenFile(tokenFile, 'saved-token-0123456789');
  const decision = await decideToken({ tokenFile, open: true });
  assert.equal(decision.token, undefined);
  assert.match(decision.note, /--no-token/);
  assert.equal((await readFile(tokenFile, 'utf8')).trim(), 'saved-token-0123456789', 'the file is left alone');
});

test('precedence is set, rotate, flag, environment, file', async () => {
  const tokenFile = await tmp();
  await writeTokenFile(tokenFile, 'from-file-0123456789');
  const env = { WEBSEARCH_MCP_UI_TOKEN: 'from-env-0123456789' };

  assert.equal((await decideToken({ tokenFile, env, set: 'from-set' })).source, 'set');
  assert.equal((await decideToken({ tokenFile, env, rotate: true, mint: () => 'from-rotate' })).token, 'from-rotate');
  assert.equal((await decideToken({ tokenFile, env, flag: 'from-flag' })).token, 'from-flag');
  assert.equal((await decideToken({ tokenFile, env })).token, 'from-env-0123456789');
  assert.equal((await decideToken({ tokenFile, env: {} })).token, 'from-file-0123456789');
});

test('only --set-token and --rotate-token ask for the value to be saved', async () => {
  const tokenFile = await tmp();
  assert.equal((await decideToken({ tokenFile, set: 'mine' })).persist, 'mine');
  assert.equal((await decideToken({ tokenFile, rotate: true, mint: () => 'minted' })).persist, 'minted');
  assert.equal((await decideToken({ tokenFile, flag: 'one-off' })).persist, undefined);
  assert.equal((await decideToken({ tokenFile, env: { WEBSEARCH_MCP_UI_TOKEN: 'e' } })).persist, undefined);
});

test('a blank token counts as unset', async () => {
  const tokenFile = await tmp();
  assert.equal((await decideToken({ tokenFile, flag: '   ', set: '' })).source, 'none');
  await writeFile(tokenFile, '\n', 'utf8');
  assert.equal((await decideToken({ tokenFile })).source, 'none');
});

test('the saved token is private and short ones are flagged', async () => {
  const tokenFile = await tmp();
  await writeTokenFile(tokenFile, 'abc');
  const stat = await import('node:fs/promises').then(fs => fs.stat(tokenFile));
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(tokenIsShort('abc'), true);
  assert.equal(tokenIsShort('a'.repeat(16)), false);
});
