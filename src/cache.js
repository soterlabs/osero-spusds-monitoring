// Tiny in-memory cache. Historical chain state is immutable, so anything keyed by
// a concrete block number is cached forever; only "latest" lookups get a TTL.

const store = new Map();

export async function cached(key, ttlSeconds, fn) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && (hit.expires === Infinity || hit.expires > now)) return hit.value;

  // De-duplicate concurrent misses so a burst of requests triggers one RPC call.
  if (hit?.pending) return hit.pending;

  const pending = (async () => {
    const value = await fn();
    store.set(key, {
      value,
      expires: ttlSeconds === Infinity ? Infinity : now + ttlSeconds * 1000,
    });
    return value;
  })();

  store.set(key, { pending, expires: 0 });
  try {
    return await pending;
  } catch (err) {
    store.delete(key);
    throw err;
  }
}

export const forever = Infinity;
