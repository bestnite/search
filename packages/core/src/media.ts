import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Images are part of what a post says, but a text answer cannot show one. The read tools therefore
 * download the pictures a post carries into a scratch directory and hand back the paths, so the
 * host's image reader can open them.
 *
 * Every link a caller passes is reported and every one that fits is downloaded, because which picture
 * matters is the reader's judgement, not this module's. What is bounded is cost: a size ceiling per
 * file, a byte budget per call, and files older than an hour are swept before the next write, since
 * nothing else knows when they stop being needed.
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
  /** How many images to download. Defaults to every link, capped at 24. */
  limit?: number;
  /** Largest file to keep. Defaults to 8 MiB. */
  maxBytes?: number;
  maxAgeMs?: number;
  /** Stop downloading once this many bytes have arrived. Defaults to 48 MiB. */
  totalBytes?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/avif': 'avif',
};
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 24;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;
const DEFAULT_TOTAL_BYTES = 48 * 1024 * 1024;

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
  const totalBudget = options.totalBytes ?? DEFAULT_TOTAL_BYTES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const dir = options.dir ?? mediaDir();
  const unique = [...new Set(urls.filter(url => typeof url === 'string' && /^https?:\/\//.test(url)))].slice(0, limit);
  if (!unique.length) return [];
  const fetchImpl = options.fetch ?? fetch;
  await mkdir(dir, { recursive: true });
  await sweep(dir, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);

  let spent = 0;
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
      if (spent + buffer.byteLength > totalBudget) return { url, error: `not downloaded: the ${totalBudget} byte budget for one call is used up` };
      spent += buffer.byteLength;
      const path = join(dir, `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.${extension}`);
      await writeFile(path, buffer);
      return { url, path, contentType, bytes: buffer.byteLength };
    } catch (error) {
      return { url, error: error instanceof Error ? error.message : String(error) };
    }
  }));
}
