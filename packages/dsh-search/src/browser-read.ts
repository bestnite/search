import type { SearchConfig, XhsContext } from '@nite07/search-core';

/**
 * The browser read context shared by the search path and the direct note/comment tool.
 *
 * The per-site read cap is part of the browser session identity, so a direct read that left it out
 * would open a second session at the default cap instead of joining the one search uses. The
 * endpoint, session file and timeout follow the same precedence search applies: the shared browser
 * block wins, and the backend's own endpoint is only a fallback.
 */
export function xhsBrowserRead(config: SearchConfig, token: string | undefined, signal: AbortSignal): XhsContext {
  const backend = config.backends.xiaohongshu!;
  const settings = backend.options as { statePath?: string };
  const wsEndpoint = config.browser.endpoint || backend.endpoint;
  if (!wsEndpoint) throw new Error('No browser endpoint is configured. Set the shared browser endpoint, or the Xiaohongshu backend endpoint.');
  const statePath = settings.statePath || config.browser.statePath;
  return {
    wsEndpoint,
    ...(token ? { token } : {}),
    ...(statePath ? { statePath } : {}),
    timeoutMs: config.browser.timeoutMs || backend.timeoutMs,
    maxConcurrentReads: config.browser.maxConcurrentReads,
    maxPooledTabs: config.browser.maxPooledTabs,
    signal,
  };
}
