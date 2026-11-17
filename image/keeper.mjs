#!/usr/bin/env node
/**
 * Holds the sign-in window open.
 *
 * A Playwright browser server only shows a window while a client is attached, so this client stays
 * attached: Xiaohongshu opens on the container display, a person signs in over VNC whenever they
 * get to it, and the session is written to the profile volume as soon as it appears.
 *
 * Reads never use this connection — the search core opens its own context — so this exists purely
 * for the human step and for keeping the session fresh.
 */
import { chromium } from 'patchright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const endpointFile = env.XHS_ENDPOINT_FILE ?? '/tmp/xhs-endpoint';
const profileDir = env.XHS_PROFILE_DIR ?? '/profile';
const statePath = env.XHS_STATE_PATH ?? join(profileDir, 'state.json');
const siteUrl = env.XHS_LOGIN_URL ?? 'https://www.xiaohongshu.com/explore';
const token = (env.XHS_WS_TOKEN ?? '').trim();
const intervalMs = Number(env.XHS_KEEPER_INTERVAL_MS ?? 15000);

const log = message => { process.stderr.write(`[keeper] ${message}\n`); };
mkdirSync(profileDir, { recursive: true });

const waitForEndpoint = async (deadline = Date.now() + 60000) => {
  while (Date.now() < deadline) {
    try {
      const value = readFileSync(endpointFile, 'utf8').trim();
      if (value !== '') return value;
    } catch {
      // The launcher has not announced itself yet.
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`no endpoint in ${endpointFile}`);
};

/** Ask the site's own client whether this page is signed in. */
const signedIn = async page => page.evaluate(async () => {
  let captured = null;
  try {
    window.webpackChunkxhs_pc_web.push([['keeper_' + Date.now()], {}, req => { captured = req; }]);
  } catch { return false; }
  let src = '';
  const modules = captured?.m ?? {};
  for (const key of Object.keys(modules)) {
    try { src = String(modules[key]); } catch { continue; }
    if (src.includes('/api/sns/web/v1/feed') && src.includes('/api/sns/web/v2/user/me')) break;
  }
  const reg = /registerHttp[^]*?\}\(\w+\((\d+)\)\.([A-Za-z_$][\w$]*)\)\}/.exec(src);
  if (!reg) return false;
  const mod = captured(Number(reg[1]));
  const candidate = mod?.[reg[2]];
  const client = candidate?.get ? candidate : candidate?.default;
  if (!client?.get) return false;
  try {
    const me = await client.get('/api/sns/web/v2/user/me');
    return me?.guest === false;
  } catch {
    return false;
  }
}, undefined, {}, false);

const endpoint = await waitForEndpoint();
const browser = await chromium.connect(endpoint, { timeout: 20000, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
const context = await browser.newContext({ locale: 'zh-CN', viewport: null, ...(existsSync(statePath) ? { storageState: statePath } : {}) });
const page = context.pages()[0] ?? await context.newPage();
await page.goto(siteUrl, { waitUntil: 'domcontentloaded' });
await page.bringToFront();
log(`sign-in window is open at ${siteUrl}; use the VNC page`);

let lastSaved = 0;
const keep = async () => {
  try {
    if (page.isClosed()) return;
    if (await signedIn(page)) {
      if (Date.now() - lastSaved > 60000) {
        await context.storageState({ path: statePath });
        lastSaved = Date.now();
        log(`session saved to ${statePath}`);
      }
    }
  } catch (error) {
    log(`check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

setInterval(() => { void keep(); }, intervalMs).unref?.();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await context.storageState({ path: statePath }).catch(() => undefined);
    await browser.close().catch(() => undefined);
    process.exit(0);
  });
}

// Stay attached: this is what keeps the window on the display.
await new Promise(() => undefined);
