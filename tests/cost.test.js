// Config reads the environment at import time; these tests never touch the
// network, so placeholders are enough.
process.env.RPC_URL ??= 'http://127.0.0.1:1';
process.env.ETHERSCAN_API_KEY ??= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { buildDayGrid, costOfFundsAt, spreadAt } = await import('../src/cost.js');

const DAY = 86_400;
const INCEPTION = 1784882111; // 2026-07-24 08:35:11 UTC — the live position

/* ------------------------------------------------------------------ *
 * Day grid
 * ------------------------------------------------------------------ */

const totalSeconds = (rows) => rows.reduce((a, r) => a + r.seconds, 0);

test('day-grid fractions sum exactly to the elapsed time', () => {
  const now = INCEPTION + 3 * DAY + 12 * 3600;
  assert.equal(totalSeconds(buildDayGrid(INCEPTION, now)), now - INCEPTION);
});

test('the first day is prorated from inception, not from midnight', () => {
  const rows = buildDayGrid(INCEPTION, INCEPTION + 3 * DAY);
  // 2026-07-24 08:35:11 → end of day is 0.6422 of a day away.
  assert.equal(Number((rows[0].seconds / DAY).toFixed(4)), 0.6422);
  assert.equal(rows[0].date, '2026-07-24');
});

test('whole middle days are exactly one day', () => {
  const rows = buildDayGrid(INCEPTION, INCEPTION + 5 * DAY);
  for (const r of rows.slice(1, -1)) assert.equal(r.seconds, DAY);
});

test('only the final row is marked partial', () => {
  const rows = buildDayGrid(INCEPTION, INCEPTION + 3 * DAY);
  assert.deepEqual(rows.map((r) => r.partial), [false, false, false, true]);
});

test('a position opened an hour ago yields one partial day', () => {
  const rows = buildDayGrid(INCEPTION, INCEPTION + 3600);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seconds, 3600);
  assert.ok(rows[0].partial);
});

test('an empty window produces no rows rather than a negative charge', () => {
  assert.deepEqual(buildDayGrid(INCEPTION, INCEPTION), []);
  assert.deepEqual(buildDayGrid(INCEPTION, INCEPTION - DAY), []);
});

test('grid rows are contiguous — no gaps and no double counting', () => {
  const rows = buildDayGrid(INCEPTION, INCEPTION + 7 * DAY + 999);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prevTs, rows[i - 1].tsUsed);
  assert.equal(rows[0].prevTs, INCEPTION);
});

/* ------------------------------------------------------------------ *
 * Spread schedule — 30bps → 20bps on 2026-07-23
 * ------------------------------------------------------------------ */

test('spread flips exactly on the effective date', () => {
  assert.equal(spreadAt('2026-07-22'), 30);
  assert.equal(spreadAt('2026-07-23'), 20); // inclusive on the day it took effect
  assert.equal(spreadAt('2026-07-24'), 20);
});

test('spread before any schedule entry falls back to the earliest', () => {
  assert.equal(spreadAt('1999-01-01'), 30);
});

test('spread far in the future holds the latest entry', () => {
  assert.equal(spreadAt('2099-01-01'), 20);
});

/* ------------------------------------------------------------------ *
 * Cumulative cost interpolation
 * ------------------------------------------------------------------ */

const usds = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const costRow = (prevTs, tsUsed, cof) => ({ prevTs, tsUsed, seconds: tsUsed - prevTs, cof });

const ROWS = [
  costRow(0, DAY, usds(10)),
  costRow(DAY, 2 * DAY, usds(20)),
  costRow(2 * DAY, 3 * DAY, usds(30)),
];

test('cost at a day boundary is the running sum', () => {
  assert.equal(costOfFundsAt(ROWS, DAY), usds(10));
  assert.equal(costOfFundsAt(ROWS, 2 * DAY), usds(30));
  assert.equal(costOfFundsAt(ROWS, 3 * DAY), usds(60));
});

test('cost mid-day is prorated linearly within that day', () => {
  // Half through day 2: 10 + 20/2 = 20
  assert.equal(costOfFundsAt(ROWS, DAY + DAY / 2), usds(20));
});

test('cost before inception is zero', () => {
  assert.equal(costOfFundsAt(ROWS, 0), 0n);
  assert.equal(costOfFundsAt(ROWS, -DAY), 0n);
});

test('cost past the end of the series is the total, not extrapolated', () => {
  assert.equal(costOfFundsAt(ROWS, 100 * DAY), usds(60));
});

test('cost over an empty series is zero', () => {
  assert.equal(costOfFundsAt([], 12345), 0n);
});

test('cost is monotonically non-decreasing across the window', () => {
  let prev = -1n;
  for (let ts = 0; ts <= 3 * DAY; ts += DAY / 8) {
    const v = costOfFundsAt(ROWS, ts);
    assert.ok(v >= prev, `dropped at ts=${ts}`);
    prev = v;
  }
});
