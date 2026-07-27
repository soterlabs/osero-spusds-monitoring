/**
 * Global RPC throttle.
 *
 * Free RPC tiers rate-limit aggressively, and a position with a long flow
 * history needs a couple of archive calls per flow. Requests are therefore
 * capped both in flight and in rate. Crucially, a 429 pauses *every* worker,
 * not just the one that hit it — otherwise all in-flight requests retry into
 * the same wall at once and burn their attempts together.
 */

const CONCURRENCY = Number(process.env.RPC_CONCURRENCY || 4);
const MIN_INTERVAL_MS = Number(process.env.RPC_MIN_INTERVAL_MS || 50);
const MAX_RETRIES = Number(process.env.RPC_MAX_RETRIES || 10);
const MAX_BACKOFF_MS = Number(process.env.RPC_MAX_BACKOFF_MS || 8000);

let active = 0;
let lastStart = 0;
let cooldownUntil = 0;
const queue = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pump() {
  if (active >= CONCURRENCY || queue.length === 0) return;
  const now = Date.now();
  const wait = Math.max(lastStart + MIN_INTERVAL_MS - now, cooldownUntil - now);
  if (wait > 0) {
    setTimeout(pump, wait);
    return;
  }
  const job = queue.shift();
  active++;
  lastStart = now;
  job();
}

const isRateLimit = (err) => {
  const s = `${err?.status ?? ''} ${err?.message ?? ''} ${err?.details ?? ''} ${err?.shortMessage ?? ''}`;
  return /429|too many requests|rate limit|exceeded|capacity/i.test(s);
};

async function attempt(fn) {
  let lastErr;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    // Respect a cooldown another worker may have just triggered.
    const wait = cooldownUntil - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRateLimit(err) || i === MAX_RETRIES) break;
      const backoff = Math.min(MAX_BACKOFF_MS, 300 * 2 ** i) * (0.7 + Math.random() * 0.6);
      cooldownUntil = Math.max(cooldownUntil, Date.now() + backoff);
    }
  }
  if (isRateLimit(lastErr)) {
    throw Object.assign(
      new Error(
        'Upstream RPC rate limit exceeded. This position has a long history and needs many archive calls; retry shortly or use an RPC endpoint with a higher throughput limit.'
      ),
      { status: 503, cause: lastErr }
    );
  }
  throw lastErr;
}

export function withLimit(fn) {
  return new Promise((resolve, reject) => {
    queue.push(() =>
      attempt(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        })
    );
    pump();
  });
}
