#!/usr/bin/env node
/**
 * Keeps one browser window open on the container display.
 *
 * A Playwright browser server shows a window only while a client is attached, so this client stays
 * attached and holds a single window at a configurable address. A person signs in to whatever site
 * needs signing in, in that window, over VNC — this process knows nothing about any particular site.
 *
 * Every read happens in its own connection, so nothing here is on the read path: this exists to give
 * a human a window, and to keep the signed-in session on disk.
 */
import { chromium } from 'patchright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const endpointFile = env.BROWSER_ENDPOINT_FILE ?? '/tmp/browser-endpoint';
const stateDir = env.BROWSER_STATE_DIR ?? '/profile';
const statePath = env.BROWSER_STATE_PATH ?? join(stateDir, 'state.json');
const startUrl = env.BROWSER_START_URL ?? 'about:blank';
const token = (env.BROWSER_WS_TOKEN ?? '').trim();
const saveIntervalMs = Number(env.BROWSER_SAVE_INTERVAL_MS ?? 60000);

const log = message => { process.stderr.write(`[keeper] ${message}\n`); };
mkdirSync(stateDir, { recursive: true });

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

const endpoint = await waitForEndpoint();
const browser = await chromium.connect(endpoint, {
  timeout: 20000,
  ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
});
// One context for everything: the sign-in window is an ordinary browser, so cookies for every site
// a person signed into live together and travel in one state file.
const context = await browser.newContext({
  locale: env.BROWSER_LOCALE ?? 'zh-CN',
  viewport: null,
  ...(existsSync(statePath) ? { storageState: statePath } : {}),
});
const page = context.pages()[0] ?? await context.newPage();
await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(error => {
  log(`could not open ${startUrl}: ${error instanceof Error ? error.message : String(error)}`);
});
await page.bringToFront();
log(`window is open at ${page.url()}; sign in there over VNC`);
log(`session is written to ${statePath} every ${Math.round(saveIntervalMs / 1000)}s`);

let saving = false;
const save = async () => {
  if (saving) return;
  saving = true;
  try {
    await context.storageState({ path: statePath });
  } catch (error) {
    log(`could not save the session: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    saving = false;
  }
};

setInterval(() => { void save(); }, saveIntervalMs).unref?.();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await save();
    await browser.close().catch(() => undefined);
    process.exit(0);
  });
}

// Stay attached: this is what keeps the window on the display.
await new Promise(() => undefined);
