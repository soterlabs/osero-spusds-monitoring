/**
 * Pure arithmetic behind the yield and cost-of-funds numbers.
 *
 * Kept free of config, network and I/O so every formula is unit-testable on
 * its own — these are the parts where a mistake silently changes money.
 */

export const RAY = 10n ** 27n;
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_YEAR = 31_536_000;

/**
 * sUSDS `ssr()` is a per-second rate in RAY; compound it over a year.
 *
 * `Number()` loses the tail of a 28-digit RAY value, but the residual is ~1e-18
 * relative and only amplifies to ~1e-11 after the exponent — far below a
 * basis point.
 */
export const ssrToApy = (ssrRay) => (Number(ssrRay) / 1e27) ** SECONDS_PER_YEAR - 1;

/** One-day growth factor for an APY-quoted rate. */
export const dailyFactor = (apy) => (1 + apy) ** (1 / 365) - 1;

/**
 * Apply a positive rate to a wei amount without letting a float touch the
 * balance. The rate is widened to RAY (1e-27) and the multiply stays in
 * BigInt, so the result is exact to the wei for the rate given.
 *
 * The `rate → integer` step can exceed 2^53 (1% does: 1e16), at which point
 * the double rounds to the nearest representable value — a *relative* error
 * of ~1e-16, i.e. eleven orders of magnitude below a basis point. What is not
 * acceptable is a rate at or above 100% per application, which can only be a
 * misconfigured spread, so that fails loudly instead.
 */
export function applyRate(weiAmount, rate) {
  if (!Number.isFinite(rate) || rate <= 0 || weiAmount === 0n) return 0n;
  if (rate >= 1) {
    throw new Error(`Rate ${rate} is >= 100% for a single application — check the spread config.`);
  }
  const rateRay = BigInt(Math.round(rate * 1e18)) * 10n ** 9n;
  return (weiAmount * rateRay) / RAY;
}

/**
 * The holder's share of the lending pool's unborrowed underlying.
 *
 * Mirrors settlement-cycle's `lending_idle_usds`. Both balances are rebased,
 * so their ratio equals the scaled ratio — no `scaledTotalSupply` needed.
 */
export function lendingIdleFrom(position, poolIdle, totalSupply) {
  if (totalSupply <= 0n || position <= 0n) return 0n;
  return (position * poolIdle) / totalSupply;
}

/**
 * The part of the position the pool has actually lent out — the only part a
 * prime agent pays the base rate on. Algebraically `position × utilization`.
 */
export function deployedFrom(position, poolIdle, totalSupply) {
  return position - lendingIdleFrom(position, poolIdle, totalSupply);
}

/** Fraction of the pool that has been borrowed, as a float in [0, 1]. */
export function utilizationFrom(poolIdle, totalSupply) {
  if (totalSupply <= 0n) return 0;
  return Number(totalSupply - poolIdle) / Number(totalSupply);
}

/**
 * Time-weighted mean of `pick(row)` across rows, clipped at `ts`.
 *
 * Used as the denominator when annualising: a position that grew, shrank or
 * closed during the window would otherwise be measured against whatever it
 * happened to be at the end — which collapses to zero once it exits.
 */
export function timeWeightedMean(rows, ts, pick) {
  let weighted = 0n;
  let seconds = 0;
  for (const r of rows) {
    if (r.prevTs >= ts) break;
    const span = Math.min(r.tsUsed, ts) - r.prevTs;
    if (span <= 0) continue;
    weighted += pick(r) * BigInt(span);
    seconds += span;
  }
  return seconds > 0 ? weighted / BigInt(seconds) : 0n;
}
