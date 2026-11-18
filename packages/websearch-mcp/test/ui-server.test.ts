import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '@nite07/search-core';
import { startUi } from '../src/ui/server.js';
import { SESSION_COOKIE } from '../src/ui/session.js';

interface Harness {
  base: string;
  token: string;
  cookie: string;
  configPath: string;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'wsm-server-'));
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, `${JSON.stringify({ search: defaultConfig(), credentials: { exa: 'file-secret' }, compactByDefault: false }, null, 2)}\n`);
  const ui = await startUi({
    configPath,
    host: '127.0.0.1',
    port: 0,
    tokenFile: join(directory, 'ui-token'),
    version: '0.0.0-test',
    log: () => undefined,
  });
  const base = `http://127.0.0.1:${ui.port}`;
  const login = await fetch(`${base}/?token=${encodeURIComponent(ui.token)}`, { redirect: 'manual' });
  const raw = login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie') ?? '';
  return {
    base,
    token: ui.token,
    cookie: raw.split(';')[0] ?? '',
    configPath,
    close: () => ui.close(),
  };
}

const asJson = (cookie: string): RequestInit => ({ headers: { Cookie: cookie, 'Content-Type': 'application/json' } });

test('the page is closed until the token is presented', async () => {
  const h = await harness();
  try {
    const bare = await fetch(`${h.base}/`, { redirect: 'manual' });
    assert.equal(bare.status, 401);
    const wrong = await fetch(`${h.base}/?token=not-the-token`, { redirect: 'manual' });
    assert.equal(wrong.status, 401);
    const api = await fetch(`${h.base}/api/settings`);
    assert.equal(api.status, 401, 'the API needs the session cookie, not just a token');
  } finally {
    await h.close();
  }
});

test('the token buys a session cookie and then the page renders', async () => {
  const h = await harness();
  try {
    assert.match(h.cookie, new RegExp(`^${SESSION_COOKIE}=`));
    const page = await fetch(`${h.base}/`, { headers: { Cookie: h.cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /websearch-mcp/);
    assert.match(html, /id="app"/);
  } finally {
    await h.close();
  }
});

test('the settings payload carries the catalog but never a credential value', async () => {
  const h = await harness();
  try {
    const response = await fetch(`${h.base}/api/settings`, asJson(h.cookie));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes('file-secret'), false, 'a credential value must never travel to the page');
    const body = JSON.parse(text) as { configPath: string; revision: string; catalog: unknown[]; credentials: Array<{ id: string; source: string }> };
    assert.equal(body.configPath, h.configPath);
    assert.ok(body.revision.length > 0);
    assert.ok(body.catalog.length > 10);
    assert.equal(body.credentials.find(item => item.id === 'exa')?.source, 'file');
  } finally {
    await h.close();
  }
});

test('a rejected save answers 400 and leaves the file untouched', async () => {
  const h = await harness();
  try {
    const before = await readFile(h.configPath, 'utf8');
    const broken = defaultConfig();
    broken.mode = 'nonsense' as unknown as typeof broken.mode;
    const response = await fetch(`${h.base}/api/settings`, { method: 'PUT', body: JSON.stringify({ config: broken }), ...asJson(h.cookie) });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { issues: Array<{ path: string }> };
    assert.ok(body.issues.some(issue => issue.path === 'mode'));
    assert.equal(await readFile(h.configPath, 'utf8'), before);
  } finally {
    await h.close();
  }
});

test('a valid save writes the file and bumps the revision', async () => {
  const h = await harness();
  try {
    const before = JSON.parse(await readFile(h.configPath, 'utf8')) as { revision?: string };
    const next = defaultConfig();
    next.maxResults = 12;
    const response = await fetch(`${h.base}/api/settings`, { method: 'PUT', body: JSON.stringify({ config: next, compactByDefault: true }), ...asJson(h.cookie) });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { saved: boolean; revision: string };
    assert.equal(body.saved, true);
    const written = JSON.parse(await readFile(h.configPath, 'utf8')) as { search: { maxResults: number }; compactByDefault: boolean; credentials: Record<string, string> };
    assert.equal(written.search.maxResults, 12);
    assert.equal(written.compactByDefault, true);
    assert.deepEqual(written.credentials, { exa: 'file-secret' }, 'a config save keeps the credentials');
    assert.equal(body.revision === before.revision, false);
  } finally {
    await h.close();
  }
});

test('the credential endpoint writes, masks and clears', async () => {
  const h = await harness();
  try {
    const saved = await fetch(`${h.base}/api/credentials`, { method: 'POST', body: JSON.stringify({ scope: 'backend', id: 'x', value: 'auth_token=abc; ct0=def' }), ...asJson(h.cookie) });
    assert.equal(saved.status, 200);
    const body = (await saved.json()) as { state: { source: string; length: number } };
    assert.equal(body.state.source, 'file');
    const written = JSON.parse(await readFile(h.configPath, 'utf8')) as { credentials: Record<string, string> };
    assert.equal(written.credentials.x, 'auth_token=abc; ct0=def');

    const cleared = await fetch(`${h.base}/api/credentials`, { method: 'POST', body: JSON.stringify({ scope: 'backend', id: 'x', remove: true }), ...asJson(h.cookie) });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json() as { state: { source: string } }).state.source, 'none');
  } finally {
    await h.close();
  }
});

test('state changes are same-origin and JSON only', async () => {
  const h = await harness();
  try {
    const crossOrigin = await fetch(`${h.base}/api/settings`, {
      method: 'PUT',
      headers: { Cookie: h.cookie, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ config: defaultConfig() }),
    });
    assert.equal(crossOrigin.status, 403);

    const formPost = await fetch(`${h.base}/api/settings`, {
      method: 'PUT',
      headers: { Cookie: h.cookie, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ config: defaultConfig() }),
    });
    assert.equal(formPost.status, 415);
  } finally {
    await h.close();
  }
});

test('guessing the token is rate limited', async () => {
  const h = await harness();
  try {
    let last = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await fetch(`${h.base}/?token=guess-${attempt}`, { redirect: 'manual' });
      last = response.status;
    }
    assert.equal(last, 429);
  } finally {
    await h.close();
  }
});
