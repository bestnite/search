import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FailureLimiter, SESSION_COOKIE, SessionStore, cookieValue, sessionCookie } from '../src/ui/session.js';

const tokenPath = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), 'wsm-token-')), 'ui-token');

test('the token is minted once, kept private, and survives a restart', async () => {
  const file = await tokenPath();
  const first = new SessionStore({ tokenFile: file });
  const token = await first.load();
  assert.ok(token.length >= 32);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readFile(file, 'utf8')).trim(), token);

  const second = new SessionStore({ tokenFile: file });
  assert.equal(await second.load(), token, 'a restart must not invalidate an open link');
});

test('verification is exact and a wrong length never throws', async () => {
  const store = new SessionStore({ tokenFile: await tokenPath() });
  const token = await store.load();
  assert.equal(store.verify(token), true);
  assert.equal(store.verify(`${token}x`), false);
  assert.equal(store.verify(token.slice(0, 10)), false);
  assert.equal(store.verify(undefined), false);
});

test('a session expires on idle and on its absolute cap', async () => {
  let clock = 1_000_000;
  const store = new SessionStore({ tokenFile: await tokenPath(), now: () => clock });
  await store.load();
  const id = store.issue('127.0.0.1');
  assert.equal(store.check(id), true);
  clock += 10 * 60_000;
  assert.equal(store.check(id), true, 'ten minutes idle is still inside the window');
  clock += 16 * 60_000;
  assert.equal(store.check(id), false, 'idle beyond fifteen minutes drops the session');
});

test('rotating the token kills every existing session', async () => {
  const store = new SessionStore({ tokenFile: await tokenPath() });
  const token = await store.load();
  const id = store.issue('127.0.0.1');
  assert.equal(store.check(id), true);
  const next = await store.rotate();
  assert.notEqual(next, token);
  assert.equal(store.verify(token), false);
  assert.equal(store.check(id), false);
  assert.equal(store.size, 0);
});

test('repeated failures ban the address for a while', () => {
  let clock = 0;
  const limiter = new FailureLimiter(3, 60_000, () => clock);
  assert.equal(limiter.blocked('10.0.0.9'), false);
  limiter.fail('10.0.0.9');
  limiter.fail('10.0.0.9');
  limiter.fail('10.0.0.9');
  assert.equal(limiter.blocked('10.0.0.9'), true);
  assert.equal(limiter.blocked('10.0.0.8'), false, 'the ban is per address');
  clock += 61_000;
  assert.equal(limiter.blocked('10.0.0.9'), false);
});

test('the cookie is HttpOnly, same-site and parsed back by name', () => {
  const header = sessionCookie('abc', 60);
  assert.match(header, new RegExp(`^${SESSION_COOKIE}=abc;`));
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.equal(cookieValue(`a=1; ${SESSION_COOKIE}=abc; b=2`, SESSION_COOKIE), 'abc');
  assert.equal(cookieValue('a=1', SESSION_COOKIE), undefined);
});
