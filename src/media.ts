import { materialiseImages, type MediaImage } from '@nite07/search-core';

/** What a read tool adds to its answer when the post carries pictures. */
export interface ImageAttachment {
  text: string;
  images: MediaImage[];
}

/**
 * Download the pictures a post carries and point the reader at them.
 *
 * A text answer cannot show an image, and an image URL the model cannot open is not much better, so
 * the files are written to a scratch directory and their paths are listed: the host's image reader
 * opens a path. Failures are listed by URL, because a caller that asked for pictures should learn
 * which ones did not arrive.
 */
export async function attachImages(
  text: string,
  urls: readonly string[],
  options: { signal: AbortSignal },
): Promise<ImageAttachment> {
  const images = await materialiseImages(urls, { signal: options.signal });
  if (!images.length) return { text, images };
  const ready = images.filter(image => image.path);
  const lines = ['', `## Images (${images.length})`];
  for (const image of images) {
    // Every link is listed whether or not it reached disk, so the reader can choose what to open.
    lines.push(image.path ? `- ${image.path} — ${image.url}` : `- ${image.url} (not on disk: ${image.error ?? 'unknown reason'})`);
  }
  if (ready.length) lines.push('', 'Open a downloaded path with read_image to see what that picture shows; you choose which ones matter.');
  return { text: `${text}\n${lines.join('\n')}`, images };
}
