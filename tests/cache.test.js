process.env.CACHE_MAX_ENTRIES ??= '50';

import test from 'node:test';
import assert from 'node:assert/strict';

const { cached, forever, cacheSize, clearCache } = await import('../src/cache.js');

test('a hit does not re-run the producer', async () => {
  clearCache();
  let calls = 0;
  const produce = async () => { calls++; return 'v'; };
  assert.equal(await cached('k', forever, produce), 'v');
  assert.equal(await cached('k', forever, produce), 'v');
  assert.equal(calls, 1);
});

test('concurrent misses collapse into one call', async () => {
  clearCache();
  let calls = 0;
  const produce = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return 'shared';
  };
  const all = await Promise.all(Array.from({ length: 10 }, () => cached('burst', forever, produce)));
  assert.deepEqual(all, Array(10).fill('shared'));
  assert.equal(calls, 1, 'a burst of requests must trigger exactly one fetch');
});

test('a rejection is not cached and does not poison later reads', async () => {
  clearCache();
  await assert.rejects(cached('flaky', forever, async () => { throw new Error('boom'); }));
  assert.equal(await cached('flaky', forever, async () => 'recovered'), 'recovered');
});

test('every waiter on a failed fetch sees the rejection', async () => {
  clearCache();
  const produce = async () => {
    await new Promise((r) => setTimeout(r, 10));
    throw new Error('nope');
  };
  const results = await Promise.allSettled([
    cached('fail', forever, produce),
    cached('fail', forever, produce),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
});

test('a TTL entry expires and refetches', async () => {
  clearCache();
  let n = 0;
  const produce = async () => ++n;
  assert.equal(await cached('ttl', 0.02, produce), 1);
  assert.equal(await cached('ttl', 0.02, produce), 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(await cached('ttl', 0.02, produce), 2);
});

test('the cache is bounded — this is what stops the slow leak', async () => {
  clearCache();
  // Keys embed block numbers, so a long-running instance mints new ones forever.
  for (let i = 0; i < 500; i++) await cached(`block:${i}`, forever, async () => i);
  assert.ok(cacheSize() <= 50, `expected <= 50 entries, got ${cacheSize()}`);
});

test('eviction keeps the most recently used entry', async () => {
  clearCache();
  await cached('keep', forever, async () => 'original');
  for (let i = 0; i < 200; i++) {
    await cached(`filler:${i}`, forever, async () => i);
    if (i % 10 === 0) await cached('keep', forever, async () => 'refetched'); // keep it warm
  }
  assert.equal(await cached('keep', forever, async () => 'refetched'), 'original');
});
