import { chmod, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  backendCredentialRef,
  browserCredentialRef,
  catalog,
  defaultConfig,
  parseConfig,
  validateConfig,
} from '@nite07/search-core';
import type { AccessMode, BackendDefinition, ConfigIssue, SearchConfig } from '@nite07/search-core';

/** One credential row: never the value, only where it came from and how long it is. */
export interface CredentialState {
  id: string;
  ref: string;
  mode: AccessMode | null;
  source: 'env' | 'file' | 'none';
  length: number;
}

export interface SettingsSnapshot {
  configPath: string;
  revision: string;
  config: SearchConfig;
  defaults: SearchConfig;
  catalog: BackendDefinition[];
  credentials: CredentialState[];
  browser: CredentialState;
  compactByDefault: boolean;
  /** The container copy a save also refreshes, when one exists beside the file. */
  companion: { path: string; active: boolean };
  /** Set when the file on disk does not validate; the page then opens on defaults so it can be repaired. */
  loadError?: string;
}

export interface SaveResult {
  revision: string;
  backup?: string;
}

export class SettingsError extends Error {
  constructor(message: string, public readonly issues: ConfigIssue[] = [], public readonly status = 400) {
    super(message);
    this.name = 'SettingsError';
  }
}

export const MAX_CREDENTIAL_LENGTH = 16384;
/** Inside a container, loopback is the container itself, so a companion file names the host instead. */
export const CONTAINER_HOST = 'host.containers.internal';
const BACKUP_LIMIT = 5;

interface RawFile {
  search: unknown;
  credentials: Record<string, string>;
  compactByDefault: boolean;
  /** Every other top-level key is carried through untouched: the file is not owned by this page alone. */
  rest: Record<string, unknown>;
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The same settings for a client that runs in a container: loopback there means the container. */
export const companionPath = (path: string): string => `${path.replace(/\.json$/i, '')}.container.json`;

function rewriteEndpoint(endpoint: string): string {
  if (!endpoint) return endpoint;
  try {
    const url = new URL(endpoint);
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'];
    if (!loopback.includes(url.hostname)) return endpoint;
    url.hostname = CONTAINER_HOST;
    return url.toString();
  } catch {
    return endpoint;
  }
}

/** The session file is read by path, and inside the container the home directory is a read-only mount. */
const CONTAINER_HOME = '/host/home';
const CORE_BROWSER_STATE = join('.config', 'dsh-search', 'browser', 'state.json');

function containerStatePath(value: string, home: string): string {
  const written = value || join(home, CORE_BROWSER_STATE);
  let resolved = written;
  try {
    // The path is usually a symlink into the browser container's data volume; the container mount
    // sees the real directory, not the symlink, so the resolved path is what has to be mapped.
    resolved = realpathSync(written);
  } catch {
    // Not there yet: map what was written.
  }
  return resolved.startsWith(`${home}/`) ? `${CONTAINER_HOME}/${resolved.slice(home.length + 1)}` : resolved;
}

export function containerVariant(search: SearchConfig, home: string = homedir()): SearchConfig {
  const copy = structuredClone(search);
  copy.browser = {
    ...copy.browser,
    endpoint: rewriteEndpoint(copy.browser.endpoint),
    statePath: containerStatePath(copy.browser.statePath, home),
  };
  for (const backend of Object.values(copy.backends)) {
    backend.endpoint = rewriteEndpoint(backend.endpoint);
  }
  return copy;
}

/**
 * A companion file is written only when it already exists: creating one for every install would put a
 * second copy of the credentials somewhere the operator never asked for.
 */
async function writeCompanion(path: string, body: Record<string, unknown>): Promise<string | undefined> {
  const target = companionPath(path);
  const present = await readText(target);
  if (!present) return undefined;
  const variant = { ...body, search: containerVariant(body.search as SearchConfig) };
  await writeAtomic(target, `${JSON.stringify(variant, null, 2)}\n`);
  return target;
}

async function readText(path: string): Promise<{ text: string; revision: string } | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    return { text, revision: hash(text) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseRaw(text: string): RawFile {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new SettingsError('The configuration file is not valid JSON.', [{ path: '', message: String(error) }]);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SettingsError('The configuration file must hold a JSON object.');
  const record = body as Record<string, unknown>;
  const credentials: Record<string, string> = {};
  for (const [id, value] of Object.entries((record.credentials ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim() !== '') credentials[id] = value;
  }
  const { search, credentials: _credentials, compactByDefault, ...rest } = record;
  return { search: search ?? {}, credentials, compactByDefault: compactByDefault === true, rest };
}

/** Atomic and private: a half-written configuration must never be readable by the next process. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await chmod(path, 0o600).catch(() => undefined);
}

async function backup(path: string, text: string): Promise<string | undefined> {
  // Local time and milliseconds: a backup is something a person reads while looking for "the one
  // from ten minutes ago", and two saves inside the same second must not overwrite each other.
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${String(now.getMilliseconds()).padStart(3, '0')}`;
  const target = `${path}.bak-${stamp}`;
  await writeAtomic(target, text);
  const directory = dirname(path);
  const prefix = `${basename(path)}.bak-`;
  const stale = (await readdir(directory).catch(() => [] as string[])).filter(name => name.startsWith(prefix)).sort().reverse().slice(BACKUP_LIMIT);
  await Promise.all(stale.map(name => unlink(join(directory, name)).catch(() => undefined)));
  return target;
}

function credentialState(id: string, ref: string, mode: AccessMode | null, file: Record<string, string>, env: NodeJS.ProcessEnv): CredentialState {
  const fromEnv = typeof env[ref] === 'string' && env[ref] !== '';
  const fromFile = typeof file[id] === 'string' && file[id] !== '';
  return {
    id,
    ref,
    mode,
    source: fromEnv ? 'env' : fromFile ? 'file' : 'none',
    length: fromFile ? file[id]!.length : 0,
  };
}

export async function snapshot(path: string, env: NodeJS.ProcessEnv = process.env): Promise<SettingsSnapshot> {
  const file = await readText(path);
  const defaults = defaultConfig();
  let raw: RawFile | undefined;
  let loadError: string | undefined;
  if (file) {
    try {
      raw = parseRaw(file.text);
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
  }
  let config: SearchConfig = defaults;
  if (raw) {
    try {
      config = parseConfig(raw.search);
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
  }
  const stored = raw?.credentials ?? {};
  return {
    configPath: path,
    revision: file?.revision ?? 'missing',
    config,
    defaults,
    catalog,
    credentials: catalog.map(item => credentialState(item.id, backendCredentialRef(item.id), config.backends[item.id]?.mode ?? null, stored, env)),
    browser: credentialState('browser', browserCredentialRef(), null, stored, env),
    compactByDefault: raw?.compactByDefault ?? false,
    companion: { path: companionPath(path), active: Boolean(await readText(companionPath(path))) },
    ...(loadError ? { loadError } : {}),
  };
}

export interface SaveInput {
  config: unknown;
  compactByDefault?: boolean;
  expectedRevision?: string;
}

/**
 * Validates first and writes second: a rejected save leaves the file byte-identical, which is what
 * lets the page show the issues without having damaged a working configuration.
 */
export async function saveConfig(path: string, input: SaveInput): Promise<SaveResult> {
  const issues = validateConfig(input.config);
  if (issues.length) throw new SettingsError('The configuration did not validate.', issues);
  const search = parseConfig(input.config);
  const existing = await readText(path);
  if (input.expectedRevision !== undefined && input.expectedRevision !== (existing?.revision ?? 'missing')) {
    throw new SettingsError('The file changed since the page loaded it; reload before saving.', [], 409);
  }
  const raw = existing ? parseRaw(existing.text) : { search: {}, credentials: {}, compactByDefault: false, rest: {} };
  const body = {
    ...raw.rest,
    search,
    credentials: raw.credentials,
    compactByDefault: input.compactByDefault ?? raw.compactByDefault,
  };
  const text = `${JSON.stringify(body, null, 2)}\n`;
  const saved = existing ? await backup(path, existing.text) : undefined;
  await writeAtomic(path, text);
  await writeCompanion(path, body);
  return { revision: hash(text), ...(saved ? { backup: saved } : {}) };
}

export interface CredentialInput {
  scope: 'backend' | 'browser';
  id?: string;
  value?: string;
  remove?: boolean;
}

export async function saveCredential(path: string, input: CredentialInput): Promise<{ revision: string; state: CredentialState }> {
  const existing = await readText(path);
  const raw = existing ? parseRaw(existing.text) : { search: {}, credentials: {}, compactByDefault: false, rest: {} };
  const credentials = { ...raw.credentials };
  let key: string;
  if (input.scope === 'browser') {
    key = 'browser';
  } else {
    const id = String(input.id ?? '');
    if (!catalog.some(item => item.id === id)) throw new SettingsError(`Unknown backend id: ${id || '(none)'}.`);
    key = id;
  }
  if (input.remove === true) delete credentials[key];
  else {
    const value = typeof input.value === 'string' ? input.value.trim() : '';
    if (!value) throw new SettingsError('A credential cannot be empty.');
    if (value.length > MAX_CREDENTIAL_LENGTH) throw new SettingsError(`A credential is limited to ${MAX_CREDENTIAL_LENGTH} characters.`);
    credentials[key] = value;
  }
  const body = { ...raw.rest, search: raw.search, credentials, compactByDefault: raw.compactByDefault };
  const text = `${JSON.stringify(body, null, 2)}\n`;
  await writeAtomic(path, text);
  await writeCompanion(path, body);
  const after = await snapshot(path, {});
  const state = key === 'browser' ? after.browser : after.credentials.find(item => item.id === key)!;
  return { revision: hash(text), state };
}
