import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { catalog, defaultConfig, parseConfig, backendCredentialRef, browserCredentialRef } from '@nite07/search-core';
import type { BackendDefinition, SearchConfig } from '@nite07/search-core';

/**
 * The server has no settings UI, so configuration is a file plus environment variables.
 * Credential environment names are fixed in search-core; the environment wins over file values.
 */
export interface ServerConfig {
  search: SearchConfig;
  credentials: Record<string, string>;
  compactByDefault: boolean;
  configPath: string;
}

export interface LoadOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'websearch-mcp', 'config.json');

export class ConfigError extends Error {
  constructor(message: string, public readonly details: string[] = []) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Deterministic message when no config exists yet: the caller learns the exact path to create. */
export function starterConfig(): unknown {
  const search = defaultConfig();
  return {
    search,
    credentials: {},
    compactByDefault: false,
  };
}

export async function loadConfig(options: LoadOptions = {}): Promise<ServerConfig> {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? env.WEBSEARCH_MCP_CONFIG ?? DEFAULT_CONFIG_PATH;
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    throw new ConfigError(`No configuration file at ${configPath}.`, [
      `Create it, or point WEBSEARCH_MCP_CONFIG at one.`,
      `Run "websearch-mcp --print-config" to emit a starter file.`,
      'Without it no backend is enabled, so every search would fail.',
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`The configuration at ${configPath} is not valid JSON.`, [String(error)]);
  }
  const body = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  let search: SearchConfig;
  try {
    search = parseConfig(body.search ?? body);
  } catch (error) {
    throw new ConfigError(`The configuration at ${configPath} is invalid.`, String(error instanceof Error ? error.message : error).split('\n'));
  }
  const credentials: Record<string, string> = {};
  for (const [id, value] of Object.entries((body.credentials ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim() !== '') credentials[id] = value;
  }
  return {
    search: search as SearchConfig,
    credentials,
    compactByDefault: body.compactByDefault === true,
    configPath,
  };
}

/** Only fixed credential names are addressable; environment values take precedence. */
export function credentialResolver(config: ServerConfig, env: NodeJS.ProcessEnv = process.env) {
  return async (name: string): Promise<string | undefined> => {
    if (name === browserCredentialRef()) return env[name] || config.credentials.browser || undefined;
    const item = catalog.find(item => backendCredentialRef(item.id) === name && config.search.backends[item.id]?.mode !== 'browser');
    return item ? env[name] || config.credentials[item.id] || undefined : undefined;
  };
}

export function describeBackends(config: ServerConfig, env: NodeJS.ProcessEnv = process.env): Array<Record<string, unknown>> {
  const resolverIds = new Set(Object.keys(config.credentials));
  return catalog.map((backend: BackendDefinition) => {
    const saved = config.search.backends[backend.id];
    return {
      id: backend.id,
      title: backend.title,
      enabled: saved?.enabled === true,
      mode: saved?.mode,
      modes: backend.modes.map(mode => ({ mode: mode.mode, tier: mode.tier, endpoint: mode.endpoint, limits: mode.limits.en })),
      requiresCredential: saved?.mode !== 'anonymous' && saved?.mode !== 'browser',
      credentialPresent: saved?.mode === 'anonymous' ? true : saved?.mode === 'browser' ? Boolean(env[browserCredentialRef()] || config.credentials.browser) : resolverIds.has(backend.id) || Boolean(env[backendCredentialRef(backend.id)]),
      options: backend.options.map(option => ({ key: option.key, label: option.label.en, default: option.default })),
    };
  });
}

/** Cheap read used by the tool descriptions: which backends a call may actually address. */
export function enabledBackendIds(config: ServerConfig): string[] {
  return catalog.filter(item => config.search.backends[item.id]?.enabled).map(item => item.id);
}
