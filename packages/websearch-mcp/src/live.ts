import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { loadConfig, type ServerConfig } from './config.js';

/**
 * Tools read the configuration through this handle on every call instead of closing over a snapshot,
 * so an edit that lands on disk reaches a server that is already running.
 */
export interface ConfigSource {
  get(): ServerConfig;
  /** Changes whenever the configuration behind get() changed; the search engine rebuilds on a new value. */
  revision(): string;
  /**
   * Fires after a successful reload. The MCP tool surface uses it to advertise or hide a gated tool
   * without a restart; a fixed source has no changes to report.
   */
  subscribe?(listener: () => void): () => void;
}

export const fixedSource = (config: ServerConfig): ConfigSource => ({ get: () => config, revision: () => 'fixed' });

export function asSource(value: ServerConfig | ConfigSource): ConfigSource {
  return typeof (value as ConfigSource).get === 'function' ? (value as ConfigSource) : fixedSource(value as ServerConfig);
}

export interface ReloadableSource extends ConfigSource {
  close(): void;
}

/**
 * Watches the directory rather than the file: a settings page replaces the file by rename, which
 * detaches a watcher bound to the inode. A failed reload keeps the previous configuration alive and
 * says why, because a half-written file must never take the running server down.
 */
export function watchSource(initial: ServerConfig, log: (message: string) => void): ReloadableSource {
  let current = initial;
  let revision = 0;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const directory = dirname(initial.configPath);
  const name = basename(initial.configPath);

  const watcher: FSWatcher = watch(directory, { persistent: false }, (_event, filename) => {
    if (filename && basename(String(filename)) !== name) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void reload(), 150);
    timer.unref?.();
  });
  watcher.on('error', error => log(`configuration watcher stopped: ${error instanceof Error ? error.message : String(error)}`));

  async function reload(): Promise<void> {
    if (closed) return;
    try {
      current = await loadConfig({ configPath: initial.configPath });
      revision += 1;
      log(`configuration reloaded from ${initial.configPath} (revision ${revision})`);
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // One broken listener must not stop the others or the reload itself.
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      log(`configuration at ${initial.configPath} is not usable; keeping the previous one: ${reason}`);
    }
  }

  return {
    get: () => current,
    revision: () => `r${revision}`,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      listeners.clear();
      watcher.close();
    },
  };
}
