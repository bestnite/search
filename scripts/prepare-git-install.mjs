// A git install (npx git+https://…) has no dist yet, because build output is not committed. This runs
// where npm runs `prepare`: after a clone, before packing. On a developer machine the build is already
// there and nothing is rebuilt.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const built = ['packages/core/dist/index.js', 'packages/websearch-mcp/dist/main.js', 'packages/websearch-mcp/dist/ui/page.html'];
if (built.every(path => existsSync(new URL(`../${path}`, import.meta.url)))) {
  console.log('dist already present; nothing to build');
  process.exit(0);
}
for (const workspace of ['@nite07/search-core', '@nite07/websearch-mcp']) {
  const result = spawnSync('npm', ['run', 'build', '--workspace', workspace], { stdio: 'inherit', cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
