import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materialiseImages } from '../src/media.js';
import { restPost } from '../src/reddit/shape.js';

const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

/** A fetch that answers by URL, so each test states what the network does. */
const responder = (routes: Record<string, Response | (() => Response)>): typeof fetch =>
  (async input => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new Error(`unexpected url ${url}`);
    return typeof route === 'function' ? route() : route.clone();
  }) as unknown as typeof fetch;

test('images land on disk with an extension the reader understands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-'));
  const images = await materialiseImages(['https://img.example/a.webp', 'https://img.example/a.webp'], {
    dir,
    fetch: responder({ 'https://img.example/a.webp': new Response(WEBP, { headers: { 'content-type': 'image/webp' } }) }),
  });
  assert.equal(images.length, 1, 'a repeated URL is downloaded once');
  const image = images[0]!;
  assert.ok(image.path?.endsWith('.webp'));
  assert.equal(image.bytes, WEBP.byteLength);
  assert.equal((await stat(image.path!)).size, WEBP.byteLength);
  assert.deepEqual(await readFile(image.path!), WEBP);
});

test('a failure is reported in place, and the others still arrive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-'));
  const images = await materialiseImages(['https://img.example/ok.jpg', 'https://img.example/page', 'https://img.example/gone.jpg'], {
    dir,
    fetch: responder({
      'https://img.example/ok.jpg': new Response(WEBP, { headers: { 'content-type': 'image/jpeg' } }),
      'https://img.example/page': new Response('<html>', { headers: { 'content-type': 'text/html' } }),
      'https://img.example/gone.jpg': new Response('', { status: 404 }),
    }),
  });
  assert.equal(images.length, 3);
  assert.ok(images[0]!.path, 'the good one is on disk');
  assert.match(images[1]!.error!, /not an image/);
  assert.match(images[2]!.error!, /HTTP 404/);
});

test('the count and the size are bounded, and non-http urls are ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-'));
  const big = new Response(new Uint8Array(2048), { headers: { 'content-type': 'image/png' } });
  const images = await materialiseImages(
    ['data:text/plain,no', 'https://img.example/big.png', 'https://img.example/z.png', 'https://img.example/y.png'],
    { dir, limit: 3, maxBytes: 1024, fetch: responder({ 'https://img.example/big.png': big, 'https://img.example/z.png': big }) },
  );
  assert.equal(images.length, 3, 'the data: url is dropped and the limit is one');
  assert.match(images[0]!.error!, /exceeds the 1024 byte limit/);
  assert.equal(images[1]!.error, images[0]!.error);
});

test('files older than the age limit are swept before the next write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-'));
  const stale = join(dir, 'stale.jpg');
  await writeFile(stale, WEBP);
  const old = new Date(Date.now() - 7200_000);
  await utimes(stale, old, old);
  await materialiseImages(['https://img.example/new.png'], {
    dir,
    fetch: responder({ 'https://img.example/new.png': new Response(WEBP, { headers: { 'content-type': 'image/png' } }) }),
  });
  const names = await readdir(dir);
  assert.ok(!names.includes('stale.jpg'), 'the stale file is gone');
  assert.equal(names.length, 1);
});

test('Reddit pictures are found in a direct link, a gallery and the preview', () => {
  const direct = restPost({ id: 'a', title: 't', permalink: '/r/x/a', author: 'u', score: 1, url: 'https://i.redd.it/a.jpg' });
  assert.deepEqual(direct.images, ['https://i.redd.it/a.jpg']);
  const gallery = restPost({
    id: 'b', title: 't', permalink: '/r/x/b', author: 'u', score: 1,
    url: 'https://www.reddit.com/gallery/b',
    media_metadata: { m1: { s: { u: 'https://preview.redd.it/b1.jpg?width=640&amp;s=abc' } } },
  });
  assert.deepEqual(gallery.images, ['https://preview.redd.it/b1.jpg?width=640&s=abc'], 'html entities are decoded');
  const preview = restPost({
    id: 'c', title: 't', permalink: '/r/x/c', author: 'u', score: 1, url: 'https://example.org/post',
    preview: { images: [{ source: { url: 'https://preview.redd.it/c.jpg?x=1&amp;y=2' } }] },
  });
  assert.deepEqual(preview.images, ['https://preview.redd.it/c.jpg?x=1&y=2']);
  const none = restPost({ id: 'd', title: 't', permalink: '/r/x/d', author: 'u', score: 1, url: 'https://example.org' });
  assert.deepEqual(none.images, []);
});
