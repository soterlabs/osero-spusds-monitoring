import { formatUnits } from 'viem';

/** Percentages are rounded for readability; the raw ratio is never lost upstream. */
export const pct = (x) => Number((x * 100).toFixed(6));

/**
 * Money as three views: `raw` (wei, exact), `formatted` (decimal string, exact)
 * and `value` (JS number — convenient, lossy above 2^53; never use it for
 * accounting).
 */
export function amount(raw, decimals) {
  return {
    raw: raw.toString(),
    formatted: formatUnits(raw, decimals),
    value: Number(formatUnits(raw, decimals)),
  };
}

export const iso = (ts) => new Date(ts * 1000).toISOString();

/** UTC calendar date (YYYY-MM-DD) of a unix timestamp. */
export const utcDate = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
