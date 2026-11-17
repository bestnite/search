#!/usr/bin/env node
/**
 * Owns the browser inside the container.
 *
 * `launchServer` publishes a Playwright endpoint other processes can attach to; `wsPath` is fixed
 * so the URL survives a restart, and the token check that replaces the random path lives in
 * ws-proxy.mjs. Launching through `connect()` right here keeps one long-lived context alive, which
 * is what the VNC viewer signs into and what the search core later reuses.
 */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const internalPort = Number(env.XHS_INTERNAL_PORT ?? 3001);
const wsPath = env.XHS_WS_PATH ?? '/xhs';
const profileDir = env.XHS_PROFILE_DIR ?? '/profile';
const statePath = join(profileDir, 'state.json');
const executablePath = readFileSync('/opt/xhs-bridge/chromium-path', 'utf8').trim();
// Headful by default: the display is virtual, and the VNC viewer needs a real window to sign in.
const headless = env.XHS_HEADLESS === 'true';
const startUrl = env.XHS_START_URL ?? 'https://www.xiaohongshu.com/explore';

mkdirSync(profileDir, { recursive: true });
const log = message => process.stderr.write(`[launcher] ${message}\n`);

const server = await chromium.launchServer({
  executablePath,
  headless,
  wsPath,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
});
log(`server ${server.wsEndpoint()}`);

// One context, kept alive: the login done over VNC lands here, and every client attaches to it.
const browser = await chromium.connect(server.wsEndpoint());
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 1440, height: 900 },
  ...(existsSync(statePath) ? { storageState: statePath } : {}),
});
const page = context.pages()[0] ?? await context.newPage();
await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(error => log(`initial navigation deferred: ${error.message}`));

let saving = false;
async function saveState() {
  if (saving) return;
  saving = true;
  try {
    await context.storageState({ path: statePath });
    log(`profile saved to ${statePath}`);
  } catch (error) {
    log(`profile save failed: ${error.message}`);
  } finally {
    saving = false;
  }
}

// Cookies rotate while a session is live; a periodic save keeps the volume current without a
// write per request, and the shutdown save covers an orderly stop.
const timer = setInterval(saveState, Number(env.XHS_SAVE_INTERVAL_MS ?? 60000));
timer.unref?.();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    clearInterval(timer);
    await saveState();
    await browser.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    process.exit(0);
  });
}

log(`browser ready on ${startUrl}`);
