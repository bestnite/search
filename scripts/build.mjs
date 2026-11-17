import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true });
const client = await build({ entryPoints: ['src/client.tsx'], bundle: true, platform: 'browser', format: 'iife', globalName: 'NiteSearchClient', target: 'es2022', loader: { '.css': 'text' }, write: false });
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:'@nite07/dsh-search',factory(require){\n${client.outputFiles[0].text}\nreturn NiteSearchClient.createClient(require('react'));\n}});\n`);
