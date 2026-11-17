import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { catalog, defaultConfig, validateConfig } from '@nite07/search-core';
import type { BackendDefinition, SearchConfig } from '@nite07/search-core';

/**
 * The server has no settings UI, so configuration is a file plus environment variables.
 * Every credential reference in the config is also an environment variable name, and the
 * environment wins: it is the safer place for a secret.
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

const expand = (value: string, env: NodeJS.ProcessEnv): string =>
  value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? '');

/** Deterministic message when no config exists yet: the caller learns the exact path to create. */
export function starterConfig(): unknown {
  const search = defaultConfig();
  return {
    search,
    credentials: Object.fromEntries(catalog.map(item => [item.id, `\${${search.backends[item.id]!.credentialRef}}`])),
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
    parsed = JSON.parse(expand(raw, env));
  } catch (error) {
    throw new ConfigError(`The configuration at ${configPath} is not valid JSON.`, [String(error)]);
  }
  const body = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const search = body.search ?? body;
  const issues = validateConfig(search);
  if (issues.length > 0) {
    throw new ConfigError(`The configuration at ${configPath} is invalid.`, issues.map(issue => `${issue.path}: ${issue.message}`));
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

/** Credential lookup order: the config value, then the environment under its reference name. */
export function credentialResolver(config: ServerConfig, env: NodeJS.ProcessEnv = process.env) {
  return async (reference: string): Promise<string | undefined> => {
    for (const item of catalog) {
      const backend = config.search.backends[item.id];
      if (backend?.credentialRef === reference) {
        const fromEnv = env[reference];
        if (fromEnv) return fromEnv;
        const stored = config.credentials[item.id];
        if (stored) return stored;
      }
    }
    return env[reference];
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
      requiresCredential: saved?.mode !== 'anonymous',
      credentialPresent: saved?.mode === 'anonymous' ? true : resolverIds.has(backend.id) || Boolean(env[saved?.credentialRef ?? '']),
      options: backend.options.map(option => ({ key: option.key, label: option.label.en, default: option.default })),
    };
  });
}

/** Cheap read used by the tool descriptions: which backends a call may actually address. */
export function enabledBackendIds(config: ServerConfig): string[] {
  return catalog.filter(item => config.search.backends[item.id]?.enabled).map(item => item.id);
}
