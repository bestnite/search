import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { attachImages } from '../src/media.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A fetch that answers by URL, so each test states what the network does. */
const responder = (routes: Record<string, Response>): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const route = routes[String(input)];
    if (!route) throw new Error(`unexpected url ${String(input)}`);
    return route.clone();
  }) as unknown as typeof fetch;

const signal = new AbortController().signal;

test('a downloaded picture is named by number, never by its link', async () => {
  const url = 'https://img.example/a.png?sig=secret';
  const attached = await attachImages('body', [url], {
    signal,
    fetch: responder({ [url]: new Response(PNG, { headers: { 'content-type': 'image/png' } }) }),
  });
  assert.match(attached.text, /## Images \(1\)/);
  assert.match(attached.text, /- image 1 → \//, 'the picture is listed by number and path');
  assert.ok(!attached.text.includes('img.example'), 'the text form carries no picture link');
  assert.ok(!attached.text.includes('secret'), 'a signature in the link does not reach the text');
  assert.equal(attached.listed.length, 1);
  assert.equal(attached.listed[0]!.index, 1);
  assert.ok(attached.listed[0]!.path, 'the path is still handed to the caller');
  assert.equal((await stat(attached.listed[0]!.path!)).size, PNG.byteLength, 'the bytes are on disk');
  assert.equal('url' in attached.listed[0]!, false, 'the user-facing projection drops the link');
  assert.equal(attached.images[0]!.url, url, 'the internal download result is unchanged');
});

test('a picture that did not arrive is named by number with its reason', async () => {
  const attached = await attachImages('body', ['https://img.example/gone.png?sig=secret'], {
    signal,
    fetch: responder({ 'https://img.example/gone.png?sig=secret': new Response('', { status: 404 }) }),
  });
  assert.match(attached.text, /- image 1 \(not downloaded: HTTP 404\)/);
  assert.ok(!attached.text.includes('img.example'), 'a failed download does not echo the link either');
  assert.ok(!attached.text.includes('read_image'), 'nothing is on disk, so the reader is not told to open one');
  assert.equal(attached.listed[0]!.error, 'HTTP 404');
});

test('a link that is not a picture does not consume a picture number', async () => {
  const attached = await attachImages('body', ['data:text/plain,no', 'https://img.example/b.png', 'https://img.example/c.png'], {
    signal,
    fetch: responder({
      'https://img.example/b.png': new Response('', { status: 404 }),
      'https://img.example/c.png': new Response(PNG, { headers: { 'content-type': 'image/png' } }),
    }),
  });
  assert.deepEqual(attached.listed.map(image => image.index), [1, 2], 'pictures are numbered 1..N, matching the count');
  assert.match(attached.text, /- image 1 \(not downloaded: HTTP 404\)/);
  assert.match(attached.text, /- image 2 → \//);
});

test('a post without pictures leaves the text alone', async () => {
  const attached = await attachImages('body', [], { signal, fetch: responder({}) });
  assert.equal(attached.text, 'body');
  assert.deepEqual(attached.images, []);
  assert.deepEqual(attached.listed, []);
});
