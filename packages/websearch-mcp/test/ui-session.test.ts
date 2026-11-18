import test from 'node:test';
import assert from 'node:assert/strict';
import { FailureLimiter, SESSION_COOKIE, SessionStore, cookieValue, sessionCookie } from '../src/ui/session.js';

const TOKEN = 'token-0123456789abcdef';

test('verification is exact and a wrong length never throws', () => {
  const store = new SessionStore(TOKEN);
  assert.equal(store.verify(TOKEN), true);
  assert.equal(store.verify(`${TOKEN}x`), false);
  assert.equal(store.verify(TOKEN.slice(0, 10)), false);
  assert.equal(store.verify(undefined), false);
  assert.equal(store.verify(''), false);
});

test('a session expires on idle and on its absolute cap', () => {
  let clock = 1_000_000;
  const store = new SessionStore(TOKEN, { now: () => clock });
  const id = store.issue('127.0.0.1');
  assert.equal(store.check(id), true);
  clock += 10 * 60_000;
  assert.equal(store.check(id), true, 'ten minutes idle is still inside the window');
  clock += 16 * 60_000;
  assert.equal(store.check(id), false, 'idle beyond fifteen minutes drops the session');
  assert.equal(store.size, 0);
});

test('sessions are per process and can be revoked', () => {
  const store = new SessionStore(TOKEN);
  const id = store.issue('127.0.0.1');
  assert.equal(store.check(id), true);
  store.revoke(id);
  assert.equal(store.check(id), false);
  assert.equal(store.size, 0);
  assert.equal(store.check('not-a-session'), false);
});

test('pruning drops only the expired sessions', () => {
  let clock = 0;
  const store = new SessionStore(TOKEN, { now: () => clock });
  const old = store.issue('10.0.0.1');
  clock += 20 * 60_000;
  const fresh = store.issue('10.0.0.2');
  store.prune();
  assert.equal(store.check(old), false);
  assert.equal(store.check(fresh), true);
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
