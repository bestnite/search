// Publishing is one-way: a version already on the registry keeps that build forever, and every later
// install of it gets that build. Committed changes left under a published version therefore look
// released while importers resolve an older one — which is how a host came to import a core export the
// published core never had. Run this before publishing; it needs the registry, so it is not part of
// `npm run check`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const load = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const pending = ['core', 'dsh-search', 'websearch-mcp'].map(folder => load(`packages/${folder}/package.json`));

/** 404 is the only answer that means the version is still free; anything else has to stop the release. */
const state = async (manifest) => {
  const url = `https://registry.npmjs.org/${manifest.name}/${manifest.version}`;
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    await response.arrayBuffer();
    return response.status;
  } catch (error) {
    return error;
  }
};

const blocked = [];
for (const manifest of pending) {
  const status = await state(manifest);
  if (status === 404) {
    console.log(`${manifest.name}@${manifest.version} is free`);
    continue;
  }
  if (status === 200) {
    blocked.push(`${manifest.name}@${manifest.version} is already published: bump the version, then release it`);
    continue;
  }
  const reason = typeof status === 'number' ? `HTTP ${status}` : status.message;
  blocked.push(`${manifest.name}@${manifest.version} could not be checked (${reason}); retry with the registry reachable`);
}
if (blocked.length) {
  for (const line of blocked) console.error(`- ${line}`);
  process.exit(1);
}

console.log(`${fileURLToPath(root)} is ready to publish ${pending.length} packages.`);
