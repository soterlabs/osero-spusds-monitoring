/**
 * Cost of funds — the interest the prime agent owes Sky on this position.
 *
 * Mirrors the settlement-cycle accounting pipeline
 * (`src/settle/compute/sky_revenue.py` + `_aggregate_lending_idle_usds`),
 * with one deliberate difference noted below.
 *
 * The rule: a prime agent pays the base rate only on the **deployed** part of
 * a SparkLend/Aave position — the share of what it supplied that the pool has
 * actually lent out. The unborrowed remainder sits idle in the aToken contract
 * and is deducted (`lending_idle_usds` in the accounting repo):
 *
 *     lendingIdle_d = position_d × poolIdle_d / totalSupply_d
 *     deployed_d    = position_d − lendingIdle_d   ≡  position_d × utilization_d
 *     cof_d         = deployed_d × dailyFactor(baseRate_d) × dayFraction_d
 *
 * The base rate is the Sky Savings Rate plus a spread, read from the SSR
 * on-chain at each day's block so rate changes are picked up automatically:
 *
 *     baseRate_d = ssrApy_d + spread_d      (ADDITIVE — see note)
 *
 * NOTE on the additive convention. settlement-cycle combines the two rates
 * multiplicatively (`combine_apys`: (1+ssr)(1+spread)−1), which is ~1.2bps
 * higher at these levels. Osero's convention is the plain sum — 3.52% + 20bps
 * = 3.72% — so that is what this service implements. On a $1M position the
 * two differ by roughly $7/year; do not expect this to tie out to the penny
 * against a settlement-cycle figure.
 *
 * DIFFERENCE IN SCOPE vs the accounting repo. settlement-cycle charges the
 * base rate on prime-level ilk debt and then allocates that charge across
 * venues pro-rata. This service computes a **bottom-up, standalone** cost for
 * one position, which is the number Osero needs to see whether this
 * allocation earns money. The two agree only when the position is funded 1:1
 * by ilk debt.
 */

import { config } from './config.js';
import { cached } from './cache.js';
import { RAY, blockAtTimestamp, dailyStateAt, getBlock, getMarket } from './chain.js';
import { pMap } from './pmap.js';
import { getFlows } from './position.js';
import { amount, iso, pct, utcDate } from './format.js';

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_YEAR = 31_536_000;

/** Spread over SSR (as a decimal) in force on a given UTC date. */
export function spreadAt(dateStr) {
  let bps = config.spreadSchedule[0].bps;
  for (const entry of config.spreadSchedule) {
    if (entry.from <= dateStr) bps = entry.bps;
    else break;
  }
  return bps;
}

/** sUSDS `ssr()` is a per-second rate in RAY; compound it over a year. */
export const ssrToApy = (ssrRay) => (Number(ssrRay) / 1e27) ** SECONDS_PER_YEAR - 1;

/** One-day growth factor for an APY-quoted rate. */
export const dailyFactor = (apy) => (1 + apy) ** (1 / 365) - 1;

/**
 * Apply a small positive rate to a wei amount without leaving integer math.
 * The rate is carried at RAY precision (1e-27), far finer than a day's
 * interest on any realistic position.
 */
function applyRate(weiAmount, rate) {
  if (rate <= 0 || weiAmount === 0n) return 0n;
  const rateRay = BigInt(Math.round(rate * 1e18)) * 10n ** 9n;
  return (weiAmount * rateRay) / RAY;
}

/**
 * One row per UTC calendar day from inception to now. The first row starts at
 * the inception timestamp (not midnight) and the last ends at "now", so both
 * partial days are charged pro-rata rather than rounded to a whole day.
 */
export function buildDayGrid(inceptionTs, nowTs) {
  const rows = [];
  let prevTs = inceptionTs;
  let dayStart = Math.floor(inceptionTs / SECONDS_PER_DAY) * SECONDS_PER_DAY;

  while (prevTs < nowTs) {
    const eod = dayStart + SECONDS_PER_DAY - 1;
    const tsUsed = Math.min(eod, nowTs);
    rows.push({
      date: utcDate(dayStart),
      prevTs,
      tsUsed,
      seconds: tsUsed - prevTs,
      partial: eod >= nowTs,
    });
    prevTs = tsUsed;
    if (eod >= nowTs) break;
    dayStart += SECONDS_PER_DAY;
  }
  return rows;
}

async function buildCostSeries() {
  const [flows, latest, market] = await Promise.all([getFlows(), getBlock(), getMarket()]);
  if (flows.length === 0) return { rows: [], total: 0n, inceptionTs: null, decimals: 18 };

  const inceptionTs = flows[0].timestamp;
  const grid = buildDayGrid(inceptionTs, latest.timestamp);

  const rows = await pMap(
    grid,
    async (g) => {
      const blockNumber =
        g.tsUsed >= latest.timestamp ? latest.number : await blockAtTimestamp(g.tsUsed);
      const s = await dailyStateAt(config.holder, blockNumber);

      const ssrApy = ssrToApy(s.ssr);
      const spreadBps = spreadAt(g.date);
      const baseApy = ssrApy + spreadBps / 10_000; // additive, per Osero convention
      const fraction = g.seconds / SECONDS_PER_DAY;
      const cof = applyRate(s.deployed, dailyFactor(baseApy) * fraction);

      return {
        ...g,
        blockNumber,
        position: s.position,
        totalSupply: s.totalSupply,
        poolIdle: s.poolIdle,
        lendingIdle: s.lendingIdle,
        deployed: s.deployed,
        utilization: s.totalSupply > 0n ? Number(s.totalSupply - s.poolIdle) / Number(s.totalSupply) : 0,
        ssrApy,
        spreadBps,
        baseApy,
        fraction,
        cof,
      };
    },
    4
  );

  let running = 0n;
  for (const r of rows) {
    running += r.cof;
    r.cumulative = running;
  }
  return { rows, total: running, inceptionTs, decimals: market.underlying.decimals };
}

/** Cached because the final row tracks "now"; historical days are immutable. */
export const getCostSeries = () => cached('cost-series', config.liveCacheTtl, buildCostSeries);

/**
 * Cumulative cost of funds at an arbitrary timestamp. Whole elapsed days are
 * summed; the day containing `ts` is prorated linearly, which is exact because
 * `deployed` is held constant across a row.
 */
export function costOfFundsAt(rows, ts) {
  let cum = 0n;
  for (const r of rows) {
    if (ts >= r.tsUsed) {
      cum += r.cof;
      continue;
    }
    if (ts > r.prevTs && r.seconds > 0) {
      cum += (r.cof * BigInt(ts - r.prevTs)) / BigInt(r.seconds);
    }
    break;
  }
  return cum;
}

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

/**
 * Cost-of-funds + net-profit block for a point in time, to be merged into a
 * `/performance`-shaped payload. `yieldToDate` is the gross yield at `ts`.
 */
export async function costSummaryAt(ts, yieldToDate) {
  const { rows, decimals, inceptionTs } = await getCostSeries();
  if (rows.length === 0 || inceptionTs === null || ts <= inceptionTs) {
    const zero = amount(0n, decimals);
    return {
      costOfFunds: { sinceInception: zero, aprPct: 0, current: null },
      net: { sinceInception: amount(yieldToDate, decimals), aprPct: 0, profitable: yieldToDate > 0n },
    };
  }

  const cof = costOfFundsAt(rows, ts);
  const net = yieldToDate - cof;
  const last = rows.findLast((r) => r.prevTs < ts) ?? rows[rows.length - 1];
  const years = (ts - inceptionTs) / SECONDS_PER_YEAR;

  // Annualise against the position size, so gross / cost / net are directly
  // comparable on the same base.
  const basis = Number(last.position) || 1;
  const annualise = (v) => (years > 0 ? Number(v) / basis / years : 0);

  return {
    costOfFunds: {
      sinceInception: amount(cof, decimals),
      aprPct: pct(annualise(cof)),
      convention: 'baseRate = ssrApy + spread (additive)',
      basis: 'deployed only — the pool has not borrowed out the idle remainder',
      current: {
        date: last.date,
        blockNumber: Number(last.blockNumber),
        ssrApyPct: pct(last.ssrApy),
        spreadBps: last.spreadBps,
        baseRateApyPct: pct(last.baseApy),
        utilizationPct: pct(last.utilization),
        position: amount(last.position, decimals),
        lendingIdle: amount(last.lendingIdle, decimals),
        deployed: amount(last.deployed, decimals),
      },
    },
    net: {
      sinceInception: amount(net, decimals),
      aprPct: pct(annualise(net)),
      profitable: net > 0n,
    },
  };
}

/** Full day-by-day breakdown — every input to the charge, for auditability. */
export async function getCostOfFundsBreakdown() {
  const { rows, total, decimals } = await getCostSeries();
  const { underlying } = await getMarket();
  return {
    holder: config.holder,
    asset: underlying,
    convention: {
      baseRate: 'ssrApy + spread (additive, NOT the multiplicative combine_apys used by settlement-cycle)',
      charged: 'deployed = position − lendingIdle ≡ position × utilization',
      lendingIdle: 'position × poolIdle / totalSupply — the holder’s share of unborrowed pool liquidity',
      dayCount: 'dailyFactor = (1 + baseApy)^(1/365) − 1, prorated on partial first/last days',
      spreadSchedule: config.spreadSchedule,
    },
    total: amount(total, decimals),
    days: rows.length,
    breakdown: rows.map((r) => ({
      date: r.date,
      blockNumber: Number(r.blockNumber),
      until: iso(r.tsUsed),
      dayFraction: Number(r.fraction.toFixed(6)),
      position: amount(r.position, decimals),
      poolTotalSupply: amount(r.totalSupply, decimals),
      poolIdle: amount(r.poolIdle, decimals),
      utilizationPct: pct(r.utilization),
      lendingIdle: amount(r.lendingIdle, decimals),
      deployed: amount(r.deployed, decimals),
      ssrApyPct: pct(r.ssrApy),
      spreadBps: r.spreadBps,
      baseRateApyPct: pct(r.baseApy),
      costOfFunds: amount(r.cof, decimals),
      cumulativeCostOfFunds: amount(r.cumulative, decimals),
    })),
  };
}
