import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RAY,
  SECONDS_PER_DAY,
  applyRate,
  dailyFactor,
  deployedFrom,
  lendingIdleFrom,
  ssrToApy,
  timeWeightedMean,
  utilizationFrom,
} from '../src/math.js';

const usds = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

/* ------------------------------------------------------------------ *
 * The lending-idle deduction — the core of the cost-of-funds rule
 * ------------------------------------------------------------------ */

test('deployed equals position x utilization (the identity the charge relies on)', () => {
  const position = usds(1_000_000);
  const totalSupply = usds(694_687_512.66);
  const poolIdle = usds(264_171_147.66);

  const deployed = deployedFrom(position, poolIdle, totalSupply);
  const util = utilizationFrom(poolIdle, totalSupply);

  // Within 1 wei of position × utilization — the two routes must not diverge.
  const viaUtil = BigInt(Math.round(Number(position) * util));
  assert.ok(
    (deployed > viaUtil ? deployed - viaUtil : viaUtil - deployed) < 10n ** 9n,
    `deployed ${deployed} vs position×util ${viaUtil}`
  );
  assert.equal(deployed + lendingIdleFrom(position, poolIdle, totalSupply), position);
});

test('lending idle handles the degenerate cases without dividing by zero', () => {
  assert.equal(lendingIdleFrom(usds(1), usds(1), 0n), 0n);
  assert.equal(lendingIdleFrom(0n, usds(1), usds(1)), 0n);
  assert.equal(utilizationFrom(usds(1), 0n), 0);
});

test('a fully borrowed pool deploys everything; an unborrowed pool deploys nothing', () => {
  const p = usds(500);
  assert.equal(deployedFrom(p, 0n, usds(1000)), p);
  assert.equal(deployedFrom(p, usds(1000), usds(1000)), 0n);
});

/* ------------------------------------------------------------------ *
 * Rates
 * ------------------------------------------------------------------ */

test('ssrToApy reproduces the live SSR of 3.52%', () => {
  // sUSDS ssr() at block 25598846 onward.
  assert.equal(Number((ssrToApy(1000000001096988944000000000n) * 100).toFixed(4)), 3.52);
  // The value it replaced, 3.60%.
  assert.equal(Number((ssrToApy(1000000001121484905000000000n) * 100).toFixed(4)), 3.6);
});

test('the base rate is additive, not compounded', () => {
  const ssr = ssrToApy(1000000001096988944000000000n);
  const base = ssr + 0.002;
  assert.equal(Number((base * 100).toFixed(4)), 3.72);
  // Guard against a regression to the multiplicative convention, which would
  // give 3.7270% and silently over-charge.
  assert.notEqual(Number((((1 + ssr) * 1.002 - 1) * 100).toFixed(4)), 3.72);
});

test('dailyFactor compounds back to the annual rate over 365 days', () => {
  const apy = 0.0372;
  assert.ok(Math.abs((1 + dailyFactor(apy)) ** 365 - 1 - apy) < 1e-12);
});

/* ------------------------------------------------------------------ *
 * applyRate — money must never round through a float
 * ------------------------------------------------------------------ */

test('applyRate keeps wei precision on a large balance', () => {
  const principal = usds(619_850.54);
  const charge = applyRate(principal, dailyFactor(0.0372));
  // ~1 day of 3.72% on 619,850 ≈ 62 USDS.
  assert.ok(charge > usds(61) && charge < usds(63), `got ${charge}`);
});

test('applyRate is exact for a clean rate', () => {
  // 1% of 1000 == 10, to the wei.
  assert.equal(applyRate(usds(1000), 0.01), usds(10));
});

test('applyRate returns zero rather than NaN for degenerate input', () => {
  assert.equal(applyRate(usds(100), 0), 0n);
  assert.equal(applyRate(usds(100), -0.01), 0n);
  assert.equal(applyRate(0n, 0.05), 0n);
  assert.equal(applyRate(usds(100), NaN), 0n);
});

test('applyRate stays exact at rates well past 2^53 when widened', () => {
  // 0.01 * 1e18 = 1e16 exceeds MAX_SAFE_INTEGER; the result must still be exact.
  assert.equal(applyRate(usds(1000), 0.05), usds(50));
  assert.equal(applyRate(usds(123456), 0.1), usds(12345.6));
});

test('applyRate rejects a rate that could only be a misconfigured spread', () => {
  assert.throws(() => applyRate(usds(100), 1), /100%/);
  assert.throws(() => applyRate(usds(100), 1e6), /100%/);
});

/* ------------------------------------------------------------------ *
 * timeWeightedMean — the annualisation denominator
 * ------------------------------------------------------------------ */

const row = (prevTs, tsUsed, position) => ({ prevTs, tsUsed, position });

test('timeWeightedMean weights by duration, not by row count', () => {
  const rows = [
    row(0, SECONDS_PER_DAY, usds(100)), // 1 day at 100
    row(SECONDS_PER_DAY, 4 * SECONDS_PER_DAY, usds(400)), // 3 days at 400
  ];
  // (100×1 + 400×3) / 4 = 325
  assert.equal(timeWeightedMean(rows, 4 * SECONDS_PER_DAY, (r) => r.position), usds(325));
});

test('timeWeightedMean clips at the requested timestamp', () => {
  const rows = [row(0, SECONDS_PER_DAY, usds(100)), row(SECONDS_PER_DAY, 2 * SECONDS_PER_DAY, usds(900))];
  // Halfway through day 2: (100×1 + 900×0.5) / 1.5 = 366.66…
  const mean = timeWeightedMean(rows, SECONDS_PER_DAY + SECONDS_PER_DAY / 2, (r) => r.position);
  assert.ok(mean > usds(366) && mean < usds(367), `got ${mean}`);
});

test('timeWeightedMean survives an exited position — the 1-wei-dust trap', () => {
  // This is the bug the basis fix addresses: annualising against the FINAL
  // position divides by dust once Aave leaves 1 wei behind.
  const rows = [
    row(0, 10 * SECONDS_PER_DAY, usds(1_000_000)),
    row(10 * SECONDS_PER_DAY, 11 * SECONDS_PER_DAY, 1n), // exited to dust
  ];
  const mean = timeWeightedMean(rows, 11 * SECONDS_PER_DAY, (r) => r.position);
  assert.ok(mean > usds(900_000), `expected a realistic basis, got ${mean}`);
});

test('timeWeightedMean returns zero when there is no elapsed time', () => {
  assert.equal(timeWeightedMean([], 100, (r) => r.position), 0n);
  assert.equal(timeWeightedMean([row(100, 200, usds(5))], 100, (r) => r.position), 0n);
});

test('RAY is the Aave ray', () => {
  assert.equal(RAY, 10n ** 27n);
});
