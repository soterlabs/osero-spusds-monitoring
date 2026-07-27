/**
 * Promise.all with a concurrency ceiling — positions with a long flow history
 * would otherwise fire thousands of archive calls at the RPC at once.
 */
export async function pMap(items, mapper, concurrency = 10) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await mapper(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
