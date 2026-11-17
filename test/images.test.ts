import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchImages } from '../src/images.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const responder = (routes: Record<string, Response>): typeof fetch =>
  (async (input: RequestInfo | URL) => routes[String(input)]!.clone()) as unknown as typeof fetch;

test('a picture is returned inline as base64 with its mime type', async () => {
  const images = await fetchImages(['https://img.example/a.png'], {
    fetch: responder({ 'https://img.example/a.png': new Response(PNG, { headers: { 'content-type': 'image/png' } }) }),
  });
  assert.equal(images.length, 1);
  assert.equal(images[0]!.mimeType, 'png');
  assert.equal(images[0]!.bytes, PNG.byteLength);
  assert.equal(Buffer.from(images[0]!.data!, 'base64').toString('hex'), PNG.toString('hex'));
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
});
