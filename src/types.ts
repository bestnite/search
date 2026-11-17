import type { BackendDefinition, BackendOutcome, SearchConfig } from '@nite07/search-core';

/** Shape of the settings page payload; it belongs to the plugin, not to the engine. */
export interface SettingsSnapshot {
  config: SearchConfig; defaults: SearchConfig; revision: string; catalog: BackendDefinition[];
  /** Which provider the web seam currently selected, and whether it is this plugin. */
  active: { searchProvider?: string; isSelf: boolean };
  credentials: Record<string, { configured: boolean; writable: boolean }>;
  /** State of the endpoint token, which belongs to the shared browser rather than to one backend. */
  browser: { credentialConfigured: boolean; writable: boolean };
  diagnostics: BackendOutcome[]; counters: Record<string, { attempts: number; day: string }>;
}
