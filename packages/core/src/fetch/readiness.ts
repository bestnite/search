import type { SearchConfig } from '../types.js';

/**
 * Readiness of a saved page-fetch chain, shared by both hosts.
 *
 * It is computed from configuration and credential presence only: no request is made and no provider
 * is called. Keys are stable so a settings page can localize them, and the text helper keeps the
 * agent-facing status readable without a second wording.
 */
export interface FetchReadinessProvider {
  id: string;
  title: string;
  serves: string[];
  modes: string[];
  /** The fetch endpoint the chain would actually use, after mode fallback. */
  endpoint: string;
  credentialRequired: boolean;
  credentialConfigured: boolean;
}

export interface FetchReadinessProblem {
  key: string;
  vars?: Record<string, string | number>;
}

export function fetchReadiness(config: SearchConfig, providers: readonly FetchReadinessProvider[]): FetchReadinessProblem[] {
  const page = config.pageFetch;
  const problems: FetchReadinessProblem[] = [];
  const enabled = page.routes.filter(route => route.enabled);
  if (!enabled.length) problems.push({ key: 'fetchNoRoutes' });
  if (!page.allowDelegatedFetching && enabled.some(route => route.kind === 'browser' || route.kind === 'provider')) {
    problems.push({ key: 'fetchDelegatedOff' });
  }
  if (enabled.some(route => route.kind === 'browser') && !config.browser.endpoint) problems.push({ key: 'fetchBrowserNoEndpoint' });
  if (enabled.some(route => route.kind === 'provider')) {
    const provider = providers.find(item => item.id === page.providerId);
    if (!provider) {
      problems.push({ key: 'fetchProviderMissing' });
    } else {
      const row = config.backends[provider.id]!;
      if (!provider.modes.includes(row.fetch.mode)) problems.push({ key: 'fetchProviderMode', vars: { provider: provider.title, mode: row.fetch.mode } });
      if (!provider.endpoint) problems.push({ key: 'fetchProviderEndpoint', vars: { provider: provider.title } });
      if (provider.credentialRequired && !provider.credentialConfigured) problems.push({ key: 'fetchProviderCredential', vars: { provider: provider.title } });
    }
  }
  return problems;
}

/** English rendering for agent-facing status output; settings pages localize the keys instead. */
export function fetchProblemText(problem: FetchReadinessProblem): string {
  const provider = String(problem.vars?.provider ?? 'the selected provider');
  switch (problem.key) {
    case 'fetchNoRoutes':
      return 'No page-fetch route is enabled, so every page fetch fails.';
    case 'fetchDelegatedOff':
      return 'A browser or provider route is enabled without the delegated-fetching opt-in, so a fetch is refused as a configuration error.';
    case 'fetchBrowserNoEndpoint':
      return 'The browser route is enabled but no shared browser endpoint is configured.';
    case 'fetchProviderMissing':
      return 'The provider route is enabled but no fetch-capable provider is selected.';
    case 'fetchProviderMode':
      return `${provider} cannot fetch in ${String(problem.vars?.mode ?? 'the saved')} access mode.`;
    case 'fetchProviderEndpoint':
      return `${provider} has no fetch endpoint configured.`;
    case 'fetchProviderCredential':
      return `${provider} needs a stored credential in its saved fetch access mode.`;
    default:
      return problem.key;
  }
}

/** Build the provider rows a readiness check needs from a catalog-backed configuration. */
export function fetchReadinessProviders(config: SearchConfig, catalog: ReadonlyArray<{ id: string; title: string; fetch?: { serves: string[]; modes: string[]; docs: string; verifiedAt: string }; modes: Array<{ mode: string; fetchEndpoint?: string }> }>, isConfigured: (id: string) => boolean): FetchReadinessProvider[] {
  const providers: FetchReadinessProvider[] = [];
  for (const definition of catalog) {
    if (!definition.fetch) continue;
    const row = config.backends[definition.id]?.fetch;
    if (!row) continue;
    const endpoint = row.endpoint || definition.modes.find(mode => mode.mode === row.mode)?.fetchEndpoint || '';
    const credentialRequired = row.mode !== 'anonymous';
    providers.push({
      id: definition.id,
      title: definition.title,
      serves: [...definition.fetch.serves],
      modes: [...definition.fetch.modes],
      endpoint,
      credentialRequired,
      credentialConfigured: credentialRequired ? isConfigured(definition.id) : true,
    });
  }
  return providers;
}
