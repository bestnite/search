import { createHash } from 'node:crypto';

/**
 * Pictures travel inside the MCP response.
 *
 * A path on this server's disk is useless to a client on another machine, and an image URL the model
 * cannot open is not much better, so the bytes are fetched here and returned as MCP image content.
 * That makes the payload the thing to bound: a few pictures per call, a ceiling per file and in
 * total, and the rest reported by number only.
 *
 * Image links may be signed and time-limited, so no entry carries one. A picture is named by its
 * position in the caller's list, which the reader can match to the note it came from, and by a short
 * digest of its link, which tells two pictures apart without revealing either.
 */
export interface InlineImage {
  /** Position among the picture links, counting from 1. */
  index: number;
  /** First 8 hex characters of the sha256 of the link: stable and discriminating, but not the link. */
  digest: string;
  mimeType: string;
  /** Base64 payload, present only when the picture was actually fetched. */
  data?: string;
  bytes?: number;
  error?: string;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/avif': 'avif',
};

/** A short, stable label for one picture link that can be printed without printing the link. */
export function imageDigest(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 8);
}

/**
 * The text form of the picture list. Every picture is named by number and digest and the ones that
 * arrived say so; the link is never printed, because it may carry a signature. A client that cannot
 * read image content still learns which pictures exist and why some are missing.
 */
export function renderImageList(text: string, images: readonly InlineImage[]): string {
  if (!images.length) return text;
  const lines = [text, '', `## Images (${images.length})`];
  for (const image of images) {
    const label = `image ${image.index} (${image.digest})`;
    lines.push(image.data ? `- ${label} attached (${image.mimeType}, ${image.bytes ?? 0} bytes)` : `- ${label} not attached (${image.error ?? 'unknown reason'})`);
  }
  return lines.join('\n');
}

/** Fetch pictures for one response, bounded by what a client is willing to carry. */
export async function fetchImages(
  urls: readonly string[],
  options: { limit?: number; maxBytes?: number; totalBytes?: number; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<InlineImage[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 6), 0), 12);
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const totalBytes = options.totalBytes ?? 24 * 1024 * 1024;
  const fetchImpl = options.fetch ?? fetch;
  // The number a picture is reported by is its position in the caller's list, so it stays stable
  // across deduplication and the limit: two pictures are never both called "image 1".
  const numbered = new Map<string, number>();
  for (const url of urls) {
    if (/^https?:\/\//.test(url) && !numbered.has(url)) numbered.set(url, numbered.size + 1);
  }
  const unique = [...numbered.keys()].slice(0, limit);
  let spent = 0;
  return Promise.all(unique.map(async (url, position): Promise<InlineImage> => {
    const index = numbered.get(url) ?? position + 1;
    const digest = imageDigest(url);
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        ...(options.signal ? { signal: options.signal } : {}),
        headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5' },
      });
      if (!response.ok) return { index, digest, mimeType: '', error: `HTTP ${response.status}` };
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const mimeType = EXTENSIONS[contentType];
      if (!mimeType) return { index, digest, mimeType: '', error: `not an image (${contentType || 'unknown type'})` };
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) return { index, digest, mimeType, error: `${buffer.byteLength} bytes exceeds the ${maxBytes} byte limit` };
      if (spent + buffer.byteLength > totalBytes) return { index, digest, mimeType, error: `not fetched: the ${totalBytes} byte budget for one call is used up` };
      spent += buffer.byteLength;
      return { index, digest, mimeType, bytes: buffer.byteLength, data: buffer.toString('base64') };
    } catch (error) {
      return { index, digest, mimeType: '', error: error instanceof Error ? error.message : String(error) };
    }
  }));
}
