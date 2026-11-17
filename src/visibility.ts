import type { SearchConfig } from './types.js';

/**
 * Which configuration paths are currently applicable.
 *
 * Hiding is presentation only: the stored value keeps its place in the draft, so
 * switching a switch off and on again never resets the dependent settings.
 */
export function visible(path: string, draft: Pick<SearchConfig, 'mode' | 'retry' | 'breaker' | 'cache' | 'diagnostics'>): boolean {
  if (path === 'singleBackend') return draft.mode === 'single';
  if (path.startsWith('retry.') && path !== 'retry.enabled') return draft.retry.enabled;
  if (path.startsWith('breaker.') && path !== 'breaker.enabled') return draft.breaker.enabled;
  if (path === 'cache.ttlSeconds' || path === 'cache.maxEntries') return draft.cache.enabled;
  if (path === 'diagnostics.maxEntries') return draft.diagnostics.enabled;
  return true;
}

/** Pre-flight problems that would make every search fail before the user tries one. */
export function blockersOf(draft: SearchConfig, ids: readonly string[], credentialConfigured: (id: string) => boolean, nameOf: (id: string) => string = id => id): Array<{ key: string; vars: Record<string, string | number>; jump: string }> {
  const blockers: Array<{ key: string; vars: Record<string, string | number>; jump: string }> = [];
  const enabled = ids.filter(id => draft.backends[id]?.enabled);
  if (!enabled.length) blockers.push({ key: 'blockNoBackends', vars: {}, jump: 'sec-backends' });
  if (draft.mode === 'single' && !draft.backends[draft.singleBackend]?.enabled) blockers.push({ key: 'blockSingleDisabled', vars: { backend: nameOf(draft.singleBackend) }, jump: 'singleBackend' });
  const missing = enabled.filter(id => draft.backends[id]?.mode === 'key' && !credentialConfigured(id));
  if (missing.length) blockers.push({ key: 'blockMissingCredential', vars: { list: missing.map(nameOf).join(', ') }, jump: 'sec-backends' });
  return blockers;
}
