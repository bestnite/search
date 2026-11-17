#!/usr/bin/env node
/**
 * One-time sign-in helper.
 *
 * Playwright's browser server creates its window only while a client is attached, so signing in
 * needs a client that stays put. This connects, opens Xiaohongshu in a visible window, watches for
 * a signed-in session and writes it to the profile volume; the reading path then starts signed in.
 *
 *   podman exec -it xhs-browser node /opt/xhs-bridge/login.mjs
 */
import { chromium } from 'patchright';
import { existsSync, mkdirSync } from 'node:fs';

const env = process.env;
const endpointFile = env.XHS_ENDPOINT_FILE ?? '/tmp/xhs-endpoint';
const profileDir = env.XHS_PROFILE_DIR ?? '/profile';
const statePath = env.XHS_STATE_PATH ?? `${profileDir}/state.json`;
const siteUrl = env.XHS_LOGIN_URL ?? 'https://www.xiaohongshu.com/explore';
const token = (env.XHS_WS_TOKEN ?? '').trim();
const deadlineMs = Number(env.XHS_LOGIN_TIMEOUT_MS ?? 600000);

const log = message => process.stderr.write(`[login] ${message}\n`);
mkdirSync(profileDir, { recursive: true });

const endpoint = (await import('node:fs')).readFileSync(endpointFile, 'utf8').trim();

/** Does the page look signed in? The site's own identity endpoint answers without a session. */
const signedIn = async page => page.evaluate(async () => {
  let captured = null;
  try {
    window.webpackChunkxhs_pc_web.push([['probe_' + Date.now()], {}, req => { captured = req; }]);
  } catch { return { ok: false, why: 'site runtime not ready' }; }
  let src = '';
  for (const key of Object.keys(captured?.m ?? {})) {
    try { src = String(captured.m[key]); } catch { continue; }
    if (src.includes('/api/sns/web/v1/feed') && src.includes('/api/sns/web/v2/user/me')) break;
  }
  const reg = /registerHttp[^]*?\}\(\w+\((\d+)\)\.([A-Za-z_$][\w$]*)\)\}/.exec(src);
  if (!reg) return { ok: false, why: 'http client not found' };
  const mod = captured(Number(reg[1]));
  const client = mod?.[reg[2]]?.get ? mod[reg[2]] : mod?.[reg[2]]?.default;
  try {
    const me = await client.get('/api/sns/web/v2/user/me');
    return { ok: true, guest: !!me?.guest, nick: me?.nickname ? 'present' : 'missing' };
  } catch (error) {
    return { ok: false, why: String(error?.message ?? error).slice(0, 120) };
  }
}, undefined, {}, false);

const browser = await chromium.connect(endpoint, {
  timeout: 20000,
  ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
});
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: null,
  ...(existsSync(statePath) ? { storageState: statePath } : {}),
});
const page = context.pages()[0] ?? await context.newPage();
await page.goto(siteUrl, { waitUntil: 'domcontentloaded' });
await page.bringToFront();

log('a window is now open on the container display');
log('open the VNC page, scan the Xiaohongshu login QR in that window, and leave this running');
log(`watching for a session for up to ${Math.round(deadlineMs / 1000)}s`);

const started = Date.now();
let saved = false;
while (Date.now() - started < deadlineMs) {
  const state = await signedIn(page).catch(() => ({ ok: false }));
  if (state.ok && !state.guest) {
    await context.storageState({ path: statePath });
    saved = true;
    log(`signed in; session saved to ${statePath}`);
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 5000));
}

if (!saved) {
  // Save whatever exists anyway: a partially authenticated session still saves a second login.
  await context.storageState({ path: statePath }).catch(() => undefined);
  log('no signed-in session was detected before the deadline; state saved as-is');
}

await browser.close().catch(() => undefined);
process.exit(saved ? 0 : 1);
