import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const load = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const resolveFrom = (folder, specifier) => {
  const resolution = spawnSync(process.execPath, ['--input-type=module', '-e', `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`], {
    cwd: fileURLToPath(new URL(`packages/${folder}/`, root)), encoding: 'utf8',
  });
  assert.equal(resolution.status, 0, resolution.stderr);
  return realpathSync(fileURLToPath(resolution.stdout.trim()));
};
const core = load('packages/core/package.json');
const rootManifest = load('package.json');
const dependents = [...['dsh-search', 'websearch-mcp'].map(folder => [folder, load(`packages/${folder}/package.json`)]), ['.', rootManifest]];
for (const [label, manifest] of dependents) {
  assert.equal(manifest.dependencies[core.name], core.version, `${label} must require the workspace core version`);
  console.log(`${manifest.name}@${manifest.version} uses ${manifest.dependencies[core.name]} of ${core.name}`);
}
for (const folder of ['dsh-search', 'websearch-mcp']) {
  const expected = realpathSync(fileURLToPath(new URL('packages/core/dist/index.js', root)));
  assert.equal(resolveFrom(folder, core.name), expected, `${folder} must resolve the local workspace core`);
  console.log(`${folder} resolves ${core.name} from this workspace`);
}
/**
 * A host imports names from core while its module is instantiated, so the name of a value core does not
 * export is a SyntaxError before any host code runs. The built output is read rather than the sources,
 * because a type-only name is erased by the compiler and never resolved at run time. A stale build or a
 * name that never shipped fails here instead of on someone else's machine.
 */
{
  const walk = dir =>
    readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules') return [];
      const path = `${dir}${entry.name}${entry.isDirectory() ? '/' : ''}`;
      return entry.isDirectory() ? walk(path) : [path];
    });
  const imports = /import\s*\{([^}]*)\}\s*from\s*['"](@nite07\/search-core(?:\/static)?)['"]/g;
  for (const folder of ['dsh-search', 'websearch-mcp']) {
    const wanted = new Map();
    for (const path of walk(`packages/${folder}/dist/`)) {
      if (!path.endsWith('.js')) continue;
      for (const [, list, specifier] of readFileSync(new URL(path, root), 'utf8').matchAll(imports)) {
        const set = wanted.get(specifier) ?? new Set();
        for (const name of list.split(',').map(entry => entry.split(/\s+as\s+/)[0].trim())) if (name) set.add(name);
        wanted.set(specifier, set);
      }
    }
    assert.ok(wanted.size > 0, `${folder} must import names from core`);
    for (const [specifier, names] of wanted) {
      const module = await import(pathToFileURL(resolveFrom(folder, specifier)).href);
      const missing = [...names].filter(name => !(name in module));
      assert.deepEqual(missing, [], `${folder} imports ${missing.join(', ')} from ${specifier}, which does not export them`);
      console.log(`${folder} imports ${names.size} names from ${specifier}; all are exported`);
    }
  }
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
  const entry = lock.packages[`packages/${folder}`];
  assert.equal(entry.version, manifest.version, `package-lock.json must be regenerated for ${manifest.name}`);
  const link = lock.packages[`node_modules/${manifest.name}`];
  assert.equal(link.link, true, `${manifest.name} must be a workspace link`);
  assert.equal(link.resolved, `packages/${folder}`);
}
assert.equal(lock.packages[''].dependencies[core.name], core.version, 'package-lock.json must carry the root core requirement');
console.log('Workspace dependency versions, lock entries and local resolution verified.');
