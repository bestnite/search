import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Images are part of what a post says, but a text answer cannot show one. The read tools therefore
 * download the pictures a post carries into a scratch directory and hand back the paths, so the
 * host's image reader can open them.
 *
 * Everything here is bounded: a few images per call, a size ceiling per file, and files older than
 * an hour are swept before the next write, because nothing else knows when they stop being needed.
 */
export interface MediaImage {
  url: string;
  /** Where the downloaded file is, when the download worked. */
  path?: string;
  contentType?: string;
  bytes?: number;
  /** Why this image is not on disk, when it is not. */
  error?: string;
}

export interface MediaOptions {
  /** Directory to write into. Defaults to a scratch directory under the system temp dir. */
  dir?: string;
  /** How many images to download. Defaults to 4, capped at 8. */
  limit?: number;
  /** Largest file to keep. Defaults to 8 MiB. */
  maxBytes?: number;
  maxAgeMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/avif': 'avif',
};
const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 8;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

/** The scratch directory these files live in, so a caller can point a reader at it. */
export function mediaDir(): string {
  return join(tmpdir(), 'dsh-search-media');
}

async function sweep(dir: string, maxAgeMs: number): Promise<void> {
  const now = Date.now();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(names.map(async name => {
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs > maxAgeMs) await unlink(path);
    } catch {
      // Another reader removed it first, or it is not ours.
    }
  }));
}

/**
 * Download images to disk, one entry per input, in input order. A failed download is reported in
 * place rather than dropped, because a caller that asked for pictures should learn why it got none.
 */
export async function materialiseImages(urls: readonly string[], options: MediaOptions = {}): Promise<MediaImage[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 0), MAX_LIMIT);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const dir = options.dir ?? mediaDir();
  const unique = [...new Set(urls.filter(url => typeof url === 'string' && /^https?:\/\//.test(url)))].slice(0, limit);
  if (!unique.length) return [];
  const fetchImpl = options.fetch ?? fetch;
  await mkdir(dir, { recursive: true });
  await sweep(dir, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);

  return Promise.all(unique.map(async (url): Promise<MediaImage> => {
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        ...(options.signal ? { signal: options.signal } : {}),
        headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5' },
      });
      if (!response.ok) return { url, error: `HTTP ${response.status}` };
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const extension = EXTENSIONS[contentType];
      if (!extension) return { url, error: `not an image (${contentType || 'unknown type'})` };
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) return { url, error: `${buffer.byteLength} bytes exceeds the ${maxBytes} byte limit` };
      if (buffer.byteLength === 0) return { url, error: 'empty response' };
      const path = join(dir, `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.${extension}`);
      await writeFile(path, buffer);
      return { url, path, contentType, bytes: buffer.byteLength };
    } catch (error) {
      return { url, error: error instanceof Error ? error.message : String(error) };
    }
  }));
}
