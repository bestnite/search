#!/usr/bin/env node
/**
 * Owns the browser inside the container.
 *
 * `launchServer` publishes a Playwright endpoint other processes can attach to; `wsPath` is fixed
 * so the URL survives a restart, and the token check that replaces the random path lives in
 * ws-proxy.mjs. Launching through `connect()` right here keeps one long-lived context alive, which
 * is what the VNC viewer signs into and what the search core later reuses.
 */
import { chromium } from 'patchright';
import { mkdirSync, writeFileSync } from 'node:fs';

const env = process.env;
const internalPort = Number(env.XHS_INTERNAL_PORT ?? 3001);
const wsPath = env.XHS_WS_PATH ?? '/xhs';
const profileDir = env.XHS_PROFILE_DIR ?? '/profile';
// Patchright already adjusts Playwright's launch arguments (no --enable-automation, and
// --disable-blink-features=AutomationControlled is added), so only the container needs a say.
const launchArgs = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  // The window itself is what the VNC viewer signs in through, so give it a usable size.
  `--window-size=${env.XHS_WINDOW_SIZE ?? '1440,900'}`,
];
// Headful by default: the display is virtual, and the VNC viewer needs a real window to sign in.
const headless = env.XHS_HEADLESS === 'true';
// launchServer picks its own port, so the endpoint is announced through a file the proxy reads.
const endpointFile = env.XHS_ENDPOINT_FILE ?? '/tmp/xhs-endpoint';

mkdirSync(profileDir, { recursive: true });
const log = message => process.stderr.write(`[launcher] ${message}\n`);

const server = await chromium.launchServer({
  // Real Google Chrome, the build Patchright recommends; the image installs it at build time.
  channel: 'chrome',
  headless,
  wsPath,
  args: launchArgs,
});
const endpoint = server.wsEndpoint();
writeFileSync(endpointFile, `${endpoint}\n`, { mode: 0o600 });
log(`server ${endpoint} (announced in ${endpointFile})`);

// No context is created here on purpose: Playwright scopes contexts to the client that made them,
// so anything opened in this process would be invisible to the reader. The browser window appears
// when the search core opens its own context, and that is the window the VNC viewer signs into.

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  });
}

log(`browser server ready; waiting for a client to open a page`);
