// Tiny in-memory LRU. Historical chain state is immutable, so anything keyed by
// a concrete block number is cached forever; only "latest" lookups get a TTL.
//
// The bound matters: keys embed block numbers, and every refresh of a "current"
// read mints a key for the then-latest block (~2/min at a 30s TTL). Unbounded,
// a long-running instance would accumulate them indefinitely.

const MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 20_000);

const store = new Map();

/** Map preserves insertion order, so re-inserting on hit gives us LRU ordering. */
function touch(key, entry) {
  store.delete(key);
  store.set(key, entry);
}

/** Evict least-recently-used entries, never dropping one still in flight. */
function evict() {
  if (store.size <= MAX_ENTRIES) return;
  for (const [key, entry] of store) {
    if (store.size <= MAX_ENTRIES) break;
    if (entry.pending) continue;
    store.delete(key);
  }
}

export async function cached(key, ttlSeconds, fn) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && !hit.pending && (hit.expires === Infinity || hit.expires > now)) {
    touch(key, hit);
    return hit.value;
  }

  // De-duplicate concurrent misses so a burst of requests triggers one RPC call.
  if (hit?.pending) return hit.pending;

  const pending = (async () => {
    const value = await fn();
    store.set(key, {
      value,
      expires: ttlSeconds === Infinity ? Infinity : now + ttlSeconds * 1000,
    });
    evict();
    return value;
  })();

  store.set(key, { pending, expires: 0 });
  try {
    return await pending;
  } catch (err) {
    // Only drop the failed placeholder — a later success may already have
    // replaced it with a real value.
    if (store.get(key)?.pending === pending) store.delete(key);
    throw err;
  }
}

export const forever = Infinity;

/** Test/ops helper. */
export const cacheSize = () => store.size;
export const clearCache = () => store.clear();
