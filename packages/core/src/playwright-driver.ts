/**
 * The browser driver is loaded when a browser-backed mode first reaches for it, never while this
 * package is being imported.
 *
 * patchright-core is a patched Playwright: one 3.7 MB CommonJS bundle that runs its own bootstrap at
 * require time. A static import therefore makes every consumer — a plugin's activation, a CLI that only
 * wants an HTTP search, an MCP server listing its tools — pay for it, and a driver that cannot load on a
 * particular machine takes the whole package down with a message about a name nobody called. Loading it
 * on first use keeps the failure where it belongs: on the backend that needs a browser.
 */
export type PlaywrightDriver = typeof import('patchright-core');

let loading: Promise<PlaywrightDriver> | undefined;

/** Resolve the driver once; a failed load is not cached, so the next call retries. */
export function loadPlaywright(): Promise<PlaywrightDriver> {
  loading ??= import('patchright-core').catch((error: unknown) => {
    loading = undefined;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`The browser driver (patchright-core) could not be loaded: ${detail}`);
  });
  return loading;
}
