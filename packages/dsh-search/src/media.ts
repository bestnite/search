import { materialiseImages, type MediaImage } from '@nite07/search-core';

/**
 * One picture as a tool result may carry it: which picture it is by number, and where its bytes are.
 * The source link is deliberately absent, because image links may be signed and time-limited.
 */
export interface ListedImage {
  /** Position in the post's picture list, counting from 1: the number the text form prints. */
  index: number;
  path?: string;
  contentType?: string;
  bytes?: number;
  /** Why this picture is not on disk, when it is not. */
  error?: string;
}

/** What a read tool adds to its answer when the post carries pictures. */
export interface ImageAttachment {
  text: string;
  /** The download results exactly as the media layer produced them. Internal: these carry the link. */
  images: MediaImage[];
  /** The same pictures with the link dropped, which is what may travel to the reader. */
  listed: ListedImage[];
}

/**
 * Number every picture 1..N over the distinct picture links, so a number in the text means the same
 * picture to the reader and matches the `Images (N)` count. The numbering follows the caller's order
 * and survives deduplication, which is why a repeat does not consume a number of its own.
 */
function numberImages(images: readonly MediaImage[], urls: readonly string[]): ListedImage[] {
  const positions = new Map<string, number>();
  for (const url of urls) {
    if (/^https?:\/\//.test(url) && !positions.has(url)) positions.set(url, positions.size + 1);
  }
  return images.map((image, position): ListedImage => ({
    index: positions.get(image.url) ?? position + 1,
    ...(image.path === undefined ? {} : { path: image.path }),
    ...(image.contentType === undefined ? {} : { contentType: image.contentType }),
    ...(image.bytes === undefined ? {} : { bytes: image.bytes }),
    ...(image.error === undefined ? {} : { error: image.error }),
  }));
}

/**
 * Download the pictures a post carries and point the reader at them.
 *
 * A text answer cannot show an image, and an image URL the model cannot open is not much better, so
 * the files are written to a scratch directory and their paths are listed: the host's image reader
 * opens a path. Each picture is named by its number only, because the link may be signed and
 * time-limited; a picture that did not arrive is named the same way, with the reason beside it.
 */
export async function attachImages(
  text: string,
  urls: readonly string[],
  options: { signal: AbortSignal; fetch?: typeof fetch },
): Promise<ImageAttachment> {
  const images = await materialiseImages(urls, {
    signal: options.signal,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (!images.length) return { text, images, listed: [] };
  const listed = numberImages(images, urls);
  const lines = ['', `## Images (${images.length})`];
  for (const image of listed) {
    // Every picture is listed whether or not it reached disk, so the reader can choose what to open.
    lines.push(image.path ? `- image ${image.index} → ${image.path}` : `- image ${image.index} (not downloaded: ${image.error ?? 'unknown reason'})`);
  }
  if (listed.some(image => image.path)) lines.push('', 'Open a downloaded path with read_image to see what that picture shows; you choose which ones matter.');
  return { text: `${text}\n${lines.join('\n')}`, images, listed };
}
