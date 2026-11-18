import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { loadConfig, type ServerConfig } from './config.js';

/** Tools read through this handle on every call, including immediately after a management write. */
export interface ConfigSource {
  get(): ServerConfig;
  revision(): string;
  subscribe?(listener: () => void): () => void;
  /** Reload the original path; failures propagate and leave the last good configuration intact. */
  reload?(): Promise<void>;
}

export function fixedSource(config: ServerConfig): ConfigSource {
  const configPath = config.configPath;
  let current = config;
  let revision = 0;
  let pending: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    revision: () => revision ? `r${revision}` : 'fixed',
    subscribe: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    reload: () => {
      // Serialize loads so an older disk read cannot replace a newer completed reload.
      const next = pending.catch(() => undefined).then(async () => {
        const loaded = await loadConfig({ configPath });
        current = loaded;
        revision += 1;
        for (const listener of listeners) {
          try { listener(); } catch { /* Listener failure does not invalidate a successful load. */ }
        }
      });
      pending = next;
      return next;
    },
  };
}

export function asSource(value: ServerConfig | ConfigSource): ConfigSource {
  return typeof (value as ConfigSource).get === 'function' ? value as ConfigSource : fixedSource(value as ServerConfig);
}

export interface ReloadableSource extends ConfigSource { close(): void; }

/** Watch the directory: atomic rename replaces the file inode. */
export function watchSource(initial: ServerConfig, log: (message: string) => void): ReloadableSource {
  const source = fixedSource(initial);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const watcher: FSWatcher = watch(dirname(initial.configPath), { persistent: false }, (_event, filename) => {
    if (filename && basename(String(filename)) !== basename(initial.configPath)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (closed) return;
      void source.reload!().then(() => {
        log(`configuration reloaded from ${initial.configPath} (revision ${source.revision()})`);
      }).catch(() => {
        // Parse errors can quote file contents, including credentials. Never log their raw text.
        log(`configuration at ${initial.configPath} is not usable; keeping the previous one`);
      });
    }, 150);
    timer.unref?.();
  });
  watcher.on('error', () => log('configuration watcher stopped'));
  return {
    ...source,
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
