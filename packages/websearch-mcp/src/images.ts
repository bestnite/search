/**
 * Pictures travel inside the MCP response.
 *
 * A path on this server's disk is useless to a client on another machine, and an image URL the model
 * cannot open is not much better, so the bytes are fetched here and returned as MCP image content.
 * That makes the payload the thing to bound: a few pictures per call, a ceiling per file and in
 * total, and the rest reported by URL only.
 */
export interface InlineImage {
  url: string;
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

/** Fetch pictures for one response, bounded by what a client is willing to carry. */
export async function fetchImages(
  urls: readonly string[],
  options: { limit?: number; maxBytes?: number; totalBytes?: number; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<InlineImage[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 6), 0), 12);
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const totalBytes = options.totalBytes ?? 24 * 1024 * 1024;
  const fetchImpl = options.fetch ?? fetch;
  const unique = [...new Set(urls.filter(url => /^https?:\/\//.test(url)))].slice(0, limit);
  let spent = 0;
  return Promise.all(unique.map(async (url): Promise<InlineImage> => {
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        ...(options.signal ? { signal: options.signal } : {}),
        headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5' },
      });
      if (!response.ok) return { url, mimeType: '', error: `HTTP ${response.status}` };
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const mimeType = EXTENSIONS[contentType];
      if (!mimeType) return { url, mimeType: '', error: `not an image (${contentType || 'unknown type'})` };
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) return { url, mimeType, error: `${buffer.byteLength} bytes exceeds the ${maxBytes} byte limit` };
      if (spent + buffer.byteLength > totalBytes) return { url, mimeType, error: `not fetched: the ${totalBytes} byte budget for one call is used up` };
      spent += buffer.byteLength;
      return { url, mimeType, bytes: buffer.byteLength, data: buffer.toString('base64') };
    } catch (error) {
      return { url, mimeType: '', error: error instanceof Error ? error.message : String(error) };
    }
  }));
}
