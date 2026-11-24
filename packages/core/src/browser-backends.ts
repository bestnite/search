import type { Source } from './types.js';
import { searchXhs } from './xhs/index.js';
import type { BrowserRead } from './adapters.js';

/**
 * Every backend that needs the shared browser registers here, once. The point of the indirection is
 * that adding the second one touches this file and nothing else: the adapter dispatch, the shared
 * endpoint, the session file and the timeout all come from the same place.
 */
export function registerBrowserBackends(registry: Record<string, BrowserRead>): void {
  registry.xiaohongshu = {
    async search(input, ctx): Promise<Source[]> {
      const options = input.options as { sort?: string };
      return searchXhs(
        {
          query: input.query,
          maxResults: input.maxResults,
          ...(typeof options.sort === 'string' && options.sort !== '' ? { sort: options.sort } : {}),
        },
        {
          wsEndpoint: ctx.wsEndpoint,
          ...(input.key ? { token: input.key } : {}),
          ...(ctx.statePath ? { statePath: ctx.statePath } : {}),
          timeoutMs: ctx.timeoutMs,
          maxConcurrentReads: ctx.maxConcurrentReads,
          maxPooledTabs: ctx.maxPooledTabs,
          signal: ctx.signal,
        },
      );
    },
  };
}
