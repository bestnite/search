import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { SearchEngine } from '../src/engine.js';

for (const dedup of ['url', 'url-title'] as const) {
  for (const compact of [false, true]) {
    test(`merged provenance survives ${dedup} dedup and compact=${compact}`, async () => {
      const config = defaultConfig();
      config.backends.keenable!.enabled = true;
      config.backends.searxng!.enabled = true;
      config.backends.searxng!.endpoint = 'https://searxng.example/search';
      config.safeSearch = false;
      config.retry.enabled = false;
      config.cache.enabled = true;
      config.dedup = dedup;
      config.excludeDomains = ['blocked.example'];
      let calls = 0;
      const fetcher = (async (input: string | URL | Request) => {
        calls++;
        const searxng = String(input).includes('searxng.example');
        const url = searxng && dedup === 'url-title'
          ? 'https://mirror.example/a'
          : `https://example.org/a${searxng ? '?utm_source=search#anchor' : ''}`;
        return Response.json({ results: [
          { title: 'Shared', url, snippet: 'Full snippet', content: 'Full snippet', backends: ['forged'] },
          { title: 'Shared', url, snippet: 'Duplicate', content: 'Duplicate' },
          { title: searxng ? 'Searxng only' : 'Keenable only', url: `https://example.org/${searxng ? 's' : 'k'}` },
          { title: 'Blocked', url: 'https://blocked.example/a' },
        ] });
      }) as typeof fetch;
      const engine = new SearchEngine(config, async () => undefined, fetcher);
      const result = await engine.search({ query: 'provenance' }, undefined, undefined, { compact });
      assert.equal(calls, 2);
      assert.equal(result.sources.length, 3);
      const shared = result.sources.find(source => source.title === 'Shared')!;
      assert.deepEqual(shared.backends, ['keenable', 'searxng']);
      assert.deepEqual(result.sources.find(source => source.title === 'Keenable only')!.backends, ['keenable']);
      assert.deepEqual(result.sources.find(source => source.title === 'Searxng only')!.backends, ['searxng']);
      assert.equal(result.sources.some(source => source.backends?.includes('forged')), false);
      if (compact) assert.equal(shared.snippet, undefined);
      else assert.equal(shared.snippet, 'Full snippet');
      // Provenance is added to merged copies, never to adapter outcomes.
      assert.equal(result.outcomes.some(outcome => outcome.sources.some(source => source.backends)), false);
      shared.backends!.push('mutated-by-caller');
      const cached = await engine.search({ query: 'provenance' }, undefined, undefined, { compact });
      assert.equal(cached.cached, true);
      assert.equal(calls, 2);
      assert.deepEqual(cached.sources.find(source => source.title === 'Shared')!.backends, ['keenable', 'searxng']);
    });
  }
}

test('failed backends never contribute provenance', async () => {
  const config = defaultConfig();
  config.backends.keenable!.enabled = true;
  config.backends.searxng!.enabled = true;
  config.backends.searxng!.endpoint = 'https://searxng.example/search';
  config.retry.enabled = false;
  const fetcher = (async (input: string | URL | Request) => String(input).includes('searxng.example')
    ? new Response('failure', { status: 500 })
    : Response.json({ results: [{ title: 'Only success', url: 'https://example.org/a' }] })) as typeof fetch;
  const result = await new SearchEngine(config, async () => undefined, fetcher).search({ query: 'partial' });
  assert.deepEqual(result.sources[0]!.backends, ['keenable']);
  assert.equal(result.outcomes.find(outcome => outcome.backend === 'searxng')!.ok, false);
});
