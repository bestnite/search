import { catalog, createPageFetchEngine, SearchEngine } from '@nite07/search-core';
import type { PageFetchEngine } from '@nite07/search-core';
import { credentialResolver, loadConfig, type ServerConfig } from './config.js';
import type { ConfigSource } from './live.js';
import type { ToolDefinition } from './tools.js';
import { MAX_CREDENTIAL_LENGTH, SettingsError, saveConfig, saveCredential, snapshot } from './ui/state.js';

/** Optional factories keep tests independent of network and real credentials. */
export interface ManageDependencies {
  search?(config: ServerConfig): Pick<SearchEngine, 'search'>;
  fetch?(config: ServerConfig): Pick<PageFetchEngine, 'fetchPage'>;
}

class InputError extends SettingsError {}
const invalid = (message: string): never => { throw new InputError(message); };
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
function fields(args: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(args).some(key => !allowed.includes(key))) invalid('Unexpected argument for this action.');
}
function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new SettingsError('The operation was cancelled.', [], 499);
}
/** Never return raw parse errors, provider exceptions, validation values or cancellation reasons. */
function safeError(error: unknown, signal: AbortSignal): never {
  checkSignal(signal);
  if (error instanceof InputError) throw error;
  if (error instanceof SettingsError && error.status === 409) throw new SettingsError('The configuration changed; read settings again before saving.', [], 409);
  if (error instanceof SettingsError) throw new SettingsError('The settings operation was rejected. Check the configuration and credential requirements.');
  throw new SettingsError('The operation failed. Check the saved configuration and service availability.', [], 500);
}

/** Exactly one saved, enabled backend, with a bounded result limit and safe diagnostics. */
export async function testBackend(configPath: string, args: Record<string, unknown>, signal: AbortSignal, dependencies: ManageDependencies = {}): Promise<unknown> {
  try {
    checkSignal(signal);
    if (!text(args.backendId, 100) || !catalog.some(item => item.id === args.backendId)) invalid('A known backendId is required.');
    if (!text(args.query, 10000)) invalid('A test query must contain 1–10,000 characters.');
    if (args.maxResults !== undefined && (!Number.isInteger(args.maxResults) || (args.maxResults as number) < 1 || (args.maxResults as number) > 5)) invalid('A test result limit must be an integer from 1 to 5.');
    const config = await loadConfig({ configPath });
    const backendId = args.backendId as string;
    if (!config.search.backends[backendId]?.enabled) invalid('The backend is disabled in the saved configuration; enable it and save first.');
    checkSignal(signal);
    const engine = dependencies.search?.(config) ?? new SearchEngine(config.search, credentialResolver(config));
    const result = await engine.search({ query: (args.query as string).trim(), maxResults: args.maxResults as number | undefined ?? 5 }, AbortSignal.any([signal, AbortSignal.timeout(30_000)]), backendId);
    checkSignal(signal);
    const outcome = result.outcomes[0];
    // Provider text, URLs and errors can repeat a credential. Diagnostics deliberately omit them.
    return { ok: outcome?.ok === true, backendId, sourceCount: result.sources.length, attempts: outcome?.attempts ?? 0, ...(outcome?.error ? { failure: { kind: outcome.error.kind, ...(outcome.error.status === undefined ? {} : { status: outcome.error.status }) } } : {}) };
  } catch (error) { safeError(error, signal); }
}

/** Fetch using saved routes and policy only. No endpoint, credential or route overrides are accepted. */
export async function testFetch(configPath: string, args: Record<string, unknown>, signal: AbortSignal, dependencies: ManageDependencies = {}): Promise<unknown> {
  try {
    checkSignal(signal);
    if (args.format !== 'html' && args.format !== 'markdown') invalid('A fetch test requires format html or markdown; there is no default.');
    if (!text(args.url, 8192)) invalid('A fetch test requires an absolute HTTP(S) URL.');
    let url: URL;
    try { url = new URL(args.url as string); } catch { invalid('A fetch test requires an absolute HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(url!.protocol) || url!.username || url!.password) invalid('A fetch test requires an absolute HTTP(S) URL without credentials.');
    const config = await loadConfig({ configPath });
    checkSignal(signal);
    const engine = dependencies.fetch?.(config) ?? createPageFetchEngine(config.search, { resolveCredential: credentialResolver(config) });
    const result = await engine.fetchPage({ url: (args.url as string).trim(), format: args.format as 'html' | 'markdown' }, AbortSignal.any([signal, AbortSignal.timeout(120_000)]));
    checkSignal(signal);
    return { ok: result.ok, format: result.format, stopReason: result.stopReason, ...(result.contentRoute ? { contentRoute: result.contentRoute } : {}), truncated: result.truncated, attempts: result.attempts.map(attempt => ({ route: attempt.route, outcome: attempt.outcome, ...(attempt.statusCode === undefined ? {} : { statusCode: attempt.statusCode }), ...(attempt.apiStatus === undefined ? {} : { apiStatus: attempt.apiStatus }), ...(attempt.error ? { failure: { kind: attempt.error.kind, ...(attempt.error.status === undefined ? {} : { status: attempt.error.status }) } } : {}) })) };
  } catch (error) { safeError(error, signal); }
}

/** Management is tied to the source's initial path, never a caller-selected file. */
export function createManageTool(source: ConfigSource, dependencies: ManageDependencies = {}): ToolDefinition {
  const configPath = source.get().configPath;
  return {
    name: 'search_manage',
    description: 'Read search settings, save a complete configuration, manage stored credentials, or explicitly test saved search/fetch settings. Read settings first and pass its expectedRevision for every save or credential write. Obtain explicit user authorization before any mutation, enabling a paid backend, storing/removing credentials, or running a test (which can spend paid requests). Never infer authorization from a read request. Credentials are never returned. Removing a file credential does not disable an environment credential, which takes precedence. Tests use saved settings only and return bounded diagnostics, not untrusted provider text. The configuration path cannot be changed.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['settings', 'save', 'credential', 'test', 'fetch-test'] },
        config: { type: 'object', description: 'Complete SearchConfig from settings, not a patch and not the outer file object.' },
        expectedRevision: { type: 'string', minLength: 1, maxLength: 128 },
        compactByDefault: { type: 'boolean' },
        scope: { type: 'string', enum: ['backend', 'browser'] },
        backendId: { type: 'string', minLength: 1, maxLength: 100 },
        value: { type: 'string', minLength: 1, maxLength: MAX_CREDENTIAL_LENGTH, description: 'Secret to store; never returned.' },
        remove: { type: 'boolean' },
        query: { type: 'string', minLength: 1, maxLength: 10000 },
        maxResults: { type: 'integer', minimum: 1, maximum: 5 },
        url: { type: 'string', minLength: 1, maxLength: 8192 },
        format: { type: 'string', enum: ['html', 'markdown'] },
      },
      required: ['action'],
    },
    async call(args, signal) {
      try {
        checkSignal(signal);
        if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('Arguments must be an object.');
        if (args.action === 'settings') {
          fields(args, ['action']);
          const current = await snapshot(configPath);
          checkSignal(signal);
          // Invalid stored JSON/config can contain secrets in error text. Never expose its message.
          return { ...current, ...(current.loadError ? { loadError: 'The saved configuration is invalid; repair it before use.' } : {}) };
        }
        if (args.action === 'save' || args.action === 'credential') {
          if (!source.reload) invalid('This configuration source cannot reload; management writes are unavailable.');
          if (!text(args.expectedRevision, 128)) invalid('expectedRevision from settings is required.');
          let saved: unknown;
          if (args.action === 'save') {
            fields(args, ['action', 'config', 'expectedRevision', 'compactByDefault']);
            if (!args.config || typeof args.config !== 'object' || Array.isArray(args.config)) invalid('A complete config object is required.');
            if (args.compactByDefault !== undefined && typeof args.compactByDefault !== 'boolean') invalid('compactByDefault must be a boolean.');
            saved = await saveConfig(configPath, { config: args.config, expectedRevision: args.expectedRevision as string, ...(args.compactByDefault === undefined ? {} : { compactByDefault: args.compactByDefault as boolean }), signal });
          } else {
            fields(args, ['action', 'expectedRevision', 'scope', 'backendId', 'value', 'remove']);
            if (args.scope !== 'backend' && args.scope !== 'browser') invalid('Credential scope must be backend or browser.');
            if (args.scope === 'backend' && (!text(args.backendId, 100) || !catalog.some(item => item.id === args.backendId))) invalid('A known backendId is required for backend credentials.');
            if (args.scope === 'browser' && args.backendId !== undefined) invalid('Browser credentials do not accept backendId.');
            if (args.remove !== undefined && typeof args.remove !== 'boolean') invalid('remove must be a boolean.');
            if (args.remove === true ? args.value !== undefined : !text(args.value, MAX_CREDENTIAL_LENGTH)) invalid('Provide a non-empty credential value, or remove=true without a value.');
            saved = await saveCredential(configPath, { scope: args.scope as 'backend' | 'browser', ...(args.scope === 'backend' ? { id: args.backendId as string } : {}), ...(args.remove === true ? { remove: true } : { value: args.value as string }), expectedRevision: args.expectedRevision as string, signal });
          }
          await source.reload?.();
          return { saved: true, ...(saved as Record<string, unknown>) };
        }
        if (args.action === 'test') {
          fields(args, ['action', 'backendId', 'query', 'maxResults']);
          return await testBackend(configPath, args, signal, dependencies);
        }
        if (args.action === 'fetch-test') {
          fields(args, ['action', 'url', 'format']);
          return await testFetch(configPath, args, signal, dependencies);
        }
        invalid('Unknown management action.');
      } catch (error) { safeError(error, signal); }
    },
  };
}
