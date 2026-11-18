import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const asset = fileURLToPath(new URL('./page.html', import.meta.url));
let cache: { mtimeMs: number; body: string } | undefined;

/** The page is a build asset, not a template: it ships beside the compiled server and is read once. */
export async function renderPage(): Promise<string> {
  const info = await stat(asset).catch(() => undefined);
  if (!info) throw new Error(`The settings page asset is missing at ${asset}; run npm run build.`);
  if (cache && cache.mtimeMs === info.mtimeMs) return cache.body;
  const body = await readFile(asset, 'utf8');
  cache = { mtimeMs: info.mtimeMs, body };
  return body;
}
