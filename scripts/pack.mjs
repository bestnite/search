import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = fileURLToPath(new URL('../.artifacts/', import.meta.url));
await mkdir(destination, { recursive: true });
for (const workspace of ['@nite07/search-core', '@nite07/dsh-search', '@nite07/websearch-mcp']) {
  const result = spawnSync('npm', ['pack', '--workspace', workspace, '--pack-destination', destination], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
