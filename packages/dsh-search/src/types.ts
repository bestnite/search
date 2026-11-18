import type { BackendDefinition, BackendOutcome, FetchReadinessProblem, Localized, OptionField, SearchConfig } from '@nite07/search-core';

/** Shape of the settings page payload; it belongs to the plugin, not to the engine. */
export interface SettingsSnapshot {
  config: SearchConfig; defaults: SearchConfig; revision: string; catalog: BackendDefinition[];
  /** Which provider the web seam currently selected, and whether it is this plugin. */
  active: { searchProvider?: string; isSelf: boolean };
  credentials: Record<string, { configured: boolean; writable: boolean }>;
  /** State of the endpoint token, which belongs to the shared browser rather than to one backend. */
  browser: { credentialConfigured: boolean; writable: boolean };
  diagnostics: BackendOutcome[]; counters: Record<string, { attempts: number; day: string }>;
  /** Page fetching: the fetch-capable providers and whether the saved chain can run at all. */
  fetch: FetchSettingsState;
}

/** One fetch-capable catalog entry as the Fetch tab needs it; nothing here is a user toggle. */
export interface FetchProviderInfo {
  id: string; title: string;
  /** Formats this provider can satisfy for a caller. */
  serves: string[];
  /** Access modes its fetch operation declares; a keyed mode may be documented-only, not live. */
  modes: string[];
  options: OptionField[];
  /** Configured fetch endpoint, which is deliberately separate from the search endpoint. */
  endpoint: string;
  docs: string;
  verifiedAt: string;
  notes?: Localized;
  credentialRequired: boolean;
  credentialConfigured: boolean;
}

/** One readiness reason, localized by the page and rendered in English by the status tool. */
export type FetchProblem = FetchReadinessProblem;

export interface FetchSettingsState {
  providerId: string;
  providers: FetchProviderInfo[];
  /** Why the saved chain would fail before a request, said in the page instead of after a user test. */
  problems: FetchProblem[];
  ready: boolean;
}
