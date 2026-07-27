import { formatUnits } from 'viem';
import { config } from './config.js';
import { cached } from './cache.js';
import { getTokenTransfers } from './etherscan.js';
import { pMap } from './pmap.js';
import {
  RAY,
  blockAtTimestamp,
  currentLiquidityRate,
  getBlock,
  getMarket,
  liquidityIndexAt,
  scaledBalanceAndIndexAt,
  scaledBalanceOf,
} from './chain.js';

const SECONDS_PER_YEAR = 31_536_000;

/* ------------------------------------------------------------------ *
 * Principal flows
 *
 * An Aave-style aToken balance is `scaledBalance * liquidityIndex / RAY`.
 * The scaled balance changes only when principal enters or leaves; interest
 * accrues purely through the index. So a deposit/withdrawal at block B is
 * exactly `(scaled(B) - scaled(B-1)) * index(B) / RAY`.
 *
 * We deliberately do NOT use the Transfer event amounts: Aave adds the
 * interest accrued since the user's last touch into the mint/burn Transfer
 * value, which would silently inflate "deposits" and understate yield.
 * ------------------------------------------------------------------ */

async function loadFlows() {
  const transfers = await getTokenTransfers();
  if (transfers.length === 0) return [];

  // Collapse to one entry per block — several transfers can share a block.
  const byBlock = new Map();
  for (const t of transfers) {
    const key = t.blockNumber.toString();
    const entry = byBlock.get(key) ?? {
      blockNumber: t.blockNumber,
      timestamp: t.timestamp,
      transactions: [],
    };
    if (!entry.transactions.includes(t.hash)) entry.transactions.push(t.hash);
    byBlock.set(key, entry);
  }
  const blocks = [...byBlock.values()].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));

  const priorScaled = await scaledBalanceOf(config.holder, blocks[0].blockNumber - 1n);
  const state = await pMap(blocks, (b) => scaledBalanceAndIndexAt(config.holder, b.blockNumber));

  const flows = [];
  let previousScaled = priorScaled;
  for (let i = 0; i < blocks.length; i++) {
    const { scaled, index } = state[i];
    const scaledDelta = scaled - previousScaled;
    previousScaled = scaled;
    if (scaledDelta === 0n) continue; // e.g. a zero-value transfer
    flows.push({
      ...blocks[i],
      scaledDelta,
      scaledBalanceAfter: scaled,
      liquidityIndex: index,
      // Signed principal moved, denominated in the underlying asset.
      amount: (scaledDelta * index) / RAY,
      direction: scaledDelta > 0n ? 'deposit' : 'withdrawal',
    });
  }
  return flows;
}

export const getFlows = () => cached('flows', config.liveCacheTtl, loadFlows);

/* ------------------------------------------------------------------ *
 * Point-in-time performance
 * ------------------------------------------------------------------ */

function flowsUpTo(flows, blockNumber) {
  return flows.filter((f) => f.blockNumber <= blockNumber);
}

/**
 * Time-weighted return over the intervals the position was actually funded,
 * plus how long that was. Because every supplied token grows with the reserve
 * index, the growth factor of an interval is simply index(end)/index(start) —
 * independent of position size, so deposits and withdrawals don't distort it.
 */
function timeWeightedReturn(segments) {
  let factor = RAY;
  let heldSeconds = 0;
  for (const s of segments) {
    if (s.scaledBalance <= 0n) continue;
    factor = (factor * s.endIndex) / s.startIndex;
    heldSeconds += s.endTime - s.startTime;
  }
  return { factor, heldSeconds };
}

export async function getPerformanceAt(blockNumber, timestamp) {
  const [market, allFlows, index] = await Promise.all([
    getMarket(),
    getFlows(),
    liquidityIndexAt(blockNumber),
  ]);

  const flows = flowsUpTo(allFlows, blockNumber);

  let deposited = 0n;
  let withdrawn = 0n;
  for (const f of flows) {
    if (f.amount > 0n) deposited += f.amount;
    else withdrawn += -f.amount;
  }
  const netDeposited = deposited - withdrawn;

  const scaledBalance = flows.length ? flows[flows.length - 1].scaledBalanceAfter : 0n;
  const balance = (scaledBalance * index) / RAY;
  const yieldToDate = balance - netDeposited;

  // Build the holding segments: [flow_i -> flow_i+1], then [last flow -> as-of].
  const segments = [];
  let capitalSeconds = 0n; // Σ principal * seconds, for the money-weighted rate
  let principalDuring = 0n;
  for (let i = 0; i < flows.length; i++) {
    const start = flows[i];
    principalDuring += start.amount;
    const end = flows[i + 1] ?? { timestamp, liquidityIndex: index };
    if (end.timestamp <= start.timestamp) continue;
    const scaled = start.scaledBalanceAfter;
    segments.push({
      startTime: start.timestamp,
      endTime: end.timestamp,
      startIndex: start.liquidityIndex,
      endIndex: end.liquidityIndex,
      scaledBalance: scaled,
    });
    if (scaled > 0n) {
      capitalSeconds += principalDuring * BigInt(end.timestamp - start.timestamp);
    }
  }

  const { factor, heldSeconds } = timeWeightedReturn(segments);
  const twr = Number(factor - RAY) / Number(RAY);
  const years = heldSeconds / SECONDS_PER_YEAR;

  // Money-weighted: yield over the average capital actually deployed over time.
  const avgCapital = heldSeconds > 0 ? capitalSeconds / BigInt(heldSeconds) : 0n;
  const moneyWeighted = avgCapital > 0n ? Number(yieldToDate) / Number(avgCapital) : 0;

  const d = market.underlying.decimals;
  const inception = allFlows[0] ?? null;

  return {
    market,
    inception,
    scaledBalance,
    index,
    blockNumber,
    timestamp,
    flows,
    amounts: { deposited, withdrawn, netDeposited, balance, yieldToDate },
    stats: {
      decimals: d,
      heldSeconds,
      years,
      twr,
      moneyWeighted,
      avgCapital,
      simpleApr: years > 0 ? moneyWeighted / years : 0,
      apy: years > 0 && twr > -1 ? (1 + twr) ** (1 / years) - 1 : 0,
      yieldPct: netDeposited > 0n ? Number(yieldToDate) / Number(netDeposited) : 0,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

const pct = (x) => Number((x * 100).toFixed(6));

function amount(raw, decimals) {
  return { raw: raw.toString(), formatted: formatUnits(raw, decimals), value: Number(formatUnits(raw, decimals)) };
}

const iso = (ts) => new Date(ts * 1000).toISOString();

export function serialise(p, extras = {}) {
  const d = p.stats.decimals;
  const a = (v) => amount(v, d);
  return {
    position: {
      holder: config.holder,
      market: 'SparkLend',
      aToken: p.market.aToken,
      underlying: p.market.underlying,
      pool: p.market.pool,
    },
    inception: p.inception
      ? {
          blockNumber: Number(p.inception.blockNumber),
          timestamp: p.inception.timestamp,
          date: iso(p.inception.timestamp),
          transaction: p.inception.transactions[0],
        }
      : null,
    asOf: { blockNumber: Number(p.blockNumber), timestamp: p.timestamp, date: iso(p.timestamp) },
    principal: {
      totalDeposited: a(p.amounts.deposited),
      totalWithdrawn: a(p.amounts.withdrawn),
      netDeposited: a(p.amounts.netDeposited),
    },
    balance: {
      current: a(p.amounts.balance),
      scaled: p.scaledBalance.toString(),
      liquidityIndex: formatUnits(p.index, 27),
    },
    yield: {
      // Total interest earned since inception: current value + everything ever
      // withdrawn - everything ever deposited.
      sinceInception: a(p.amounts.yieldToDate),
      sinceInceptionPct: pct(p.stats.yieldPct),
    },
    returns: {
      daysHeld: Number((p.stats.heldSeconds / 86400).toFixed(6)),
      timeWeightedReturnPct: pct(p.stats.twr),
      averageCapitalDeployed: a(p.stats.avgCapital),
      aprPct: pct(p.stats.simpleApr),
      apyPct: pct(p.stats.apy),
      ...extras.returns,
    },
    flows: p.flows.map((f) => ({
      blockNumber: Number(f.blockNumber),
      timestamp: f.timestamp,
      date: iso(f.timestamp),
      direction: f.direction,
      amount: a(f.amount > 0n ? f.amount : -f.amount),
      liquidityIndex: formatUnits(f.liquidityIndex, 27),
      transactions: f.transactions,
    })),
  };
}

/** Live snapshot, including the reserve's current supply rate. */
export async function getCurrentPerformance() {
  const block = await getBlock();
  const [p, rate] = await Promise.all([
    getPerformanceAt(block.number, block.timestamp),
    currentLiquidityRate(),
  ]);
  const apr = Number(rate) / Number(RAY);
  return serialise(p, {
    returns: {
      spotSupplyAprPct: pct(apr),
      spotSupplyApyPct: pct((1 + apr / SECONDS_PER_YEAR) ** SECONDS_PER_YEAR - 1),
    },
  });
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

const INTERVALS = { hour: 3600, day: 86400, week: 604800 };

export async function getHistory({ interval = 'day', from, to, limit = 400 }) {
  const step = INTERVALS[interval];
  if (!step) throw Object.assign(new Error(`Unknown interval "${interval}". Use hour, day or week.`), { status: 400 });

  const [flows, latest, market] = await Promise.all([getFlows(), getBlock(), getMarket()]);
  if (flows.length === 0) return { interval, count: 0, points: [] };
  const decimals = market.underlying.decimals;

  const start = from ?? flows[0].timestamp;
  const end = Math.min(to ?? latest.timestamp, latest.timestamp);
  if (end < start) throw Object.assign(new Error('`to` must be after `from`.'), { status: 400 });

  // Sample on interval boundaries, always anchored at inception and "now".
  const stamps = [start];
  for (let t = Math.ceil(start / step) * step; t < end; t += step) if (t > start) stamps.push(t);
  stamps.push(end);

  if (stamps.length > limit) {
    const keep = Math.ceil(stamps.length / limit);
    const thinned = stamps.filter((_, i) => i % keep === 0);
    if (thinned[thinned.length - 1] !== end) thinned.push(end);
    stamps.length = 0;
    stamps.push(...thinned);
  }

  const points = await pMap(stamps, async (ts) => {
    const blockNumber = ts >= latest.timestamp ? latest.number : await blockAtTimestamp(ts);
    const p = await getPerformanceAt(blockNumber, ts);
    return {
      timestamp: ts,
      date: iso(ts),
      blockNumber: Number(blockNumber),
      balance: amount(p.amounts.balance, decimals),
      netDeposited: amount(p.amounts.netDeposited, decimals),
      cumulativeYield: amount(p.amounts.yieldToDate, decimals),
      cumulativeYieldPct: pct(p.stats.yieldPct),
      aprPct: pct(p.stats.simpleApr),
    };
  }, 6);

  // Yield earned within each bucket, for charting a rate rather than a total.
  for (let i = points.length - 1; i >= 0; i--) {
    const prev = i > 0 ? BigInt(points[i - 1].cumulativeYield.raw) : 0n;
    points[i].periodYield = amount(BigInt(points[i].cumulativeYield.raw) - prev, decimals);
  }

  return { interval, from: iso(stamps[0]), to: iso(stamps[stamps.length - 1]), count: points.length, points };
}

/** Resolve a `block` or `timestamp` query into the block to evaluate against. */
export async function resolveBlock({ block, timestamp }) {
  const latest = await getBlock();

  if (block != null) {
    if (BigInt(block) > latest.number) {
      throw Object.assign(new Error(`Block ${block} is in the future; latest is ${latest.number}.`), {
        status: 400,
      });
    }
    const b = await getBlock(BigInt(block));
    return { blockNumber: b.number, timestamp: b.timestamp };
  }

  if (timestamp == null || timestamp >= latest.timestamp) {
    return { blockNumber: latest.number, timestamp: latest.timestamp };
  }
  return { blockNumber: await blockAtTimestamp(timestamp), timestamp };
}
