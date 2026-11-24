import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetchImages, imageDigest, renderImageList } from '../src/images.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const responder = (routes: Record<string, Response>): typeof fetch =>
  (async (input: RequestInfo | URL) => routes[String(input)]!.clone()) as unknown as typeof fetch;

const sha8 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 8);

test('a picture is returned inline as base64 with its mime type', async () => {
  const images = await fetchImages(['https://img.example/a.png'], {
    fetch: responder({ 'https://img.example/a.png': new Response(PNG, { headers: { 'content-type': 'image/png' } }) }),
  });
  assert.equal(images.length, 1);
  assert.equal(images[0]!.mimeType, 'png');
  assert.equal(images[0]!.bytes, PNG.byteLength);
  assert.equal(Buffer.from(images[0]!.data!, 'base64').toString('hex'), PNG.toString('hex'));
  assert.equal(images[0]!.index, 1, 'the picture is reported by its position in the list');
  assert.equal(images[0]!.digest, sha8('https://img.example/a.png'), 'the label is a short digest of the link');
  assert.equal('url' in images[0]!, false, 'the link itself is not carried');
});

test('failures and budgets are reported per link instead of dropping it', async () => {
  const chunk = new Response(new Uint8Array(600), { headers: { 'content-type': 'image/webp' } });
  const images = await fetchImages(
    ['https://img.example/1.webp', 'https://img.example/2.webp', 'https://img.example/page', 'ftp://nope'],
    {
      totalBytes: 800,
      fetch: responder({
        'https://img.example/1.webp': chunk, 'https://img.example/2.webp': chunk,
        'https://img.example/page': new Response('<html>', { headers: { 'content-type': 'text/html' } }),
      }),
    },
  );
  assert.equal(images.length, 3, 'the ftp link is not an image source');
  assert.ok(images[0]!.data);
  assert.equal(images[1]!.data, undefined);
  assert.match(images[1]!.error!, /budget for one call is used up/);
  assert.match(images[2]!.error!, /not an image/);
  assert.deepEqual(images.map(image => image.index), [1, 2, 3], 'numbers follow the input list');
  for (const image of images) assert.equal('url' in image, false, 'no entry carries a link');
});

test('a repeat and the limit do not renumber the pictures', async () => {
  const images = await fetchImages(
    ['https://img.example/a.png', 'https://img.example/a.png', 'https://img.example/b.png', 'https://img.example/c.png'],
    {
      limit: 2,
      fetch: responder({
        'https://img.example/a.png': new Response(PNG, { headers: { 'content-type': 'image/png' } }),
        'https://img.example/b.png': new Response(PNG, { headers: { 'content-type': 'image/png' } }),
      }),
    },
  );
  assert.deepEqual(images.map(image => image.index), [1, 2], 'the repeated link keeps position 1 and b keeps 2');
  assert.deepEqual(images.map(image => image.digest), [sha8('https://img.example/a.png'), sha8('https://img.example/b.png')]);
});

test('the digest is short, hexadecimal and distinguishes two links', () => {
  const one = imageDigest('https://img.example/a.png?sig=1');
  const two = imageDigest('https://img.example/a.png?sig=2');
  assert.match(one, /^[0-9a-f]{8}$/);
  assert.notEqual(one, two, 'a different link gets a different label');
  assert.equal(one, imageDigest('https://img.example/a.png?sig=1'), 'the same link always gets the same label');
});

test('the text form names pictures by number and digest, never by link', () => {
  const images = [
    { index: 1, digest: 'aaaaaaaa', mimeType: 'png', bytes: 8, data: PNG.toString('base64') },
    { index: 2, digest: 'bbbbbbbb', mimeType: '', error: 'HTTP 404' },
  ];
  const text = renderImageList('body', images);
  assert.match(text, /## Images \(2\)/);
  assert.match(text, /- image 1 \(aaaaaaaa\) attached \(png, 8 bytes\)/);
  assert.match(text, /- image 2 \(bbbbbbbb\) not attached \(HTTP 404\)/);
  assert.ok(!text.includes('http'), 'no link reaches the text form');
  assert.equal(renderImageList('body', []), 'body', 'a post without pictures is untouched');
});
