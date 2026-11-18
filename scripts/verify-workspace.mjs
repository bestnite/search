import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const load = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const core = load('packages/core/package.json');
for (const folder of ['dsh-search', 'websearch-mcp']) {
  const manifestUrl = new URL(`packages/${folder}/package.json`, root);
  const manifest = load(`packages/${folder}/package.json`);
  assert.equal(manifest.dependencies[core.name], core.version, `${folder} must require the workspace core version`);
  const resolution = spawnSync(process.execPath, ['--input-type=module', '-e', `console.log(import.meta.resolve(${JSON.stringify(core.name)}))`], {
    cwd: fileURLToPath(new URL('.', manifestUrl)), encoding: 'utf8',
  });
  assert.equal(resolution.status, 0, resolution.stderr);
  const actual = realpathSync(fileURLToPath(resolution.stdout.trim()));
  const expected = realpathSync(fileURLToPath(new URL('packages/core/dist/index.js', root)));
  assert.equal(actual, expected, `${folder} must resolve the local workspace core`);
  console.log(`${manifest.name}@${manifest.version} uses ${core.name}@${core.version} from this workspace`);
}
/**
 * The three packages used to live in separate repositories. Their names still make tempting URLs, so
 * every source file and readme is checked: a retired path in a user-agent or a docs link is invisible
 * until someone follows it.
 */
{
  const retired = /git\.nite07\.com\/nite\/(search-core|dsh-search|websearch-mcp)\b/;
  const walk = (dir) =>
    readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name === 'dist') return [];
      const path = `${dir}${entry.name}${entry.isDirectory() ? '/' : ''}`;
      return entry.isDirectory() ? walk(path) : [path];
    });
  const offenders = [];
  for (const path of [...walk('packages/'), 'README.md', 'README.zh.md']) {
    let text;
    try {
      text = readFileSync(new URL(path, root), 'utf8');
    } catch {
      continue;
    }
    if (retired.test(text)) offenders.push(path);
  }
  assert.deepEqual(offenders, [], `retired repository paths found in: ${offenders.join(', ')}`);
  console.log('No retired repository paths in sources or readmes.');
}

const lock = load('package-lock.json');
for (const folder of ['core', 'dsh-search', 'websearch-mcp']) {
  const manifest = load(`packages/${folder}/package.json`);
  assert.equal(lock.packages[`packages/${folder}`].version, manifest.version);
  const entry = lock.packages[`node_modules/${manifest.name}`];
  assert.equal(entry.link, true, `${manifest.name} must be a workspace link`);
  assert.equal(entry.resolved, `packages/${folder}`);
}
console.log('Workspace dependency versions, lock entries and local resolution verified.');
