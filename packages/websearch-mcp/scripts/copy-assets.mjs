// The settings page is a plain asset, not a template: tsc only compiles TypeScript, so the HTML is
// copied beside the compiled server and read from there at request time.
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const target = fileURLToPath(new URL('dist/ui/', root));
await mkdir(target, { recursive: true });
await copyFile(fileURLToPath(new URL('src/ui/page.html', root)), fileURLToPath(new URL('dist/ui/page.html', root)));
console.log('copied src/ui/page.html -> dist/ui/page.html');
