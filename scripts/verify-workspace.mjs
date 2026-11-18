import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
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
const lock = load('package-lock.json');
for (const folder of ['core', 'dsh-search', 'websearch-mcp']) {
  const manifest = load(`packages/${folder}/package.json`);
  assert.equal(lock.packages[`packages/${folder}`].version, manifest.version);
  const entry = lock.packages[`node_modules/${manifest.name}`];
  assert.equal(entry.link, true, `${manifest.name} must be a workspace link`);
  assert.equal(entry.resolved, `packages/${folder}`);
}
console.log('Workspace dependency versions, lock entries and local resolution verified.');
