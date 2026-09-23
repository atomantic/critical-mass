// @ts-check
// Regression test for issue #701: RegimeDashboard's "Available capital" form
// silently clamped the depositedCapital/maxUsdcDeployed it sent to the server
// (0 below $100, floored at $1000) while the toast reported the operator's
// full, unclamped delta. computeCapitalAdjustment (admin/src/utils/capitalAdjustment.mjs)
// is the pure calculation RegimeDashboard.jsx now uses to detect that drift
// up front and block the save instead of silently rewriting the numbers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../admin/src/utils/capitalAdjustment.mjs')).href);

test('rejects a non-numeric or negative target', async () => {
  const { computeCapitalAdjustment } = await load();
  const apy = { availableCapital: 500, depositedCapital: 1000, maxUsdcDeployed: 1000 };

  assert.deepEqual(computeCapitalAdjustment(apy, NaN), { ok: false, error: 'Enter a valid positive number' });
  assert.deepEqual(computeCapitalAdjustment(apy, -1), { ok: false, error: 'Enter a valid positive number' });
});

test('reports a noop when the typed value matches current available capital', async () => {
  const { computeCapitalAdjustment } = await load();
  const apy = { availableCapital: 500, depositedCapital: 1000, maxUsdcDeployed: 1000 };

  assert.deepEqual(computeCapitalAdjustment(apy, 500), { ok: true, noop: true, delta: 0 });
  // Within the existing 1-cent dead zone too.
  assert.deepEqual(computeCapitalAdjustment(apy, 500.005), { ok: true, noop: true, delta: 0 });
});

test('an ordinary deposit/withdrawal that needs no clamping computes the raw delta', async () => {
  const { computeCapitalAdjustment } = await load();
  const apy = { availableCapital: 500, depositedCapital: 1000, maxUsdcDeployed: 1000 };

  const result = computeCapitalAdjustment(apy, 750);
  assert.equal(result.ok, true);
  assert.equal(result.noop, false);
  assert.equal(result.delta, 250);
  assert.deepEqual(result.updates, { depositedCapital: 1250, maxUsdcDeployed: 1250 });
});

test('withdrawing all the way to exactly $0 deposited is the intentional auto-derive sentinel — allowed', async () => {
  const { computeCapitalAdjustment } = await load();
  // currentDeposited (1000) + delta (-1000) == 0 exactly, no clamp needed.
  const apy = { availableCapital: 1000, depositedCapital: 1000, maxUsdcDeployed: 2000 };

  const result = computeCapitalAdjustment(apy, 0);
  assert.equal(result.ok, true);
  assert.equal(result.noop, false);
  assert.deepEqual(result.updates, { depositedCapital: 0, maxUsdcDeployed: 1000 });
});

test('under-$100 edge: a withdrawal that would land deposited capital between $0 and $100 is blocked, not silently zeroed', async () => {
  const { computeCapitalAdjustment } = await load();
  // currentDeposited 1000, delta -950 -> raw 50, which the OLD code silently wrote as 0.
  const apy = { availableCapital: 1000, depositedCapital: 1000, maxUsdcDeployed: 2000 };

  const result = computeCapitalAdjustment(apy, 50);
  assert.equal(result.ok, false);
  assert.match(result.error, /\$50\.00/);
  assert.match(result.error, /\$100/);
});

test('a withdrawal that would drive deposited capital negative is blocked, not silently zeroed', async () => {
  const { computeCapitalAdjustment } = await load();
  const apy = { availableCapital: 1000, depositedCapital: 500, maxUsdcDeployed: 2000 };

  const result = computeCapitalAdjustment(apy, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /-500\.00/);
});

test('under-$1000 edge: a withdrawal that would drop max deployed below $1000 is blocked, not floored', async () => {
  const { computeCapitalAdjustment } = await load();
  // currentMax 1200, delta -300 -> raw 900, which the OLD code silently floored to 1000.
  const apy = { availableCapital: 1200, depositedCapital: 1200, maxUsdcDeployed: 1200 };

  const result = computeCapitalAdjustment(apy, 900);
  assert.equal(result.ok, false);
  assert.match(result.error, /\$900\.00/);
  assert.match(result.error, /\$1000/);
});

test('deposited-capital clamp is reported ahead of a simultaneous max clamp', async () => {
  const { computeCapitalAdjustment } = await load();
  // Both would clamp; deposited's check runs first.
  const apy = { availableCapital: 1000, depositedCapital: 1000, maxUsdcDeployed: 1000 };

  const result = computeCapitalAdjustment(apy, 40);
  assert.equal(result.ok, false);
  assert.match(result.error, /deposited capital/);
});

test('falls back through originalCapital/initialCapital and currentCapital legacy aliases', async () => {
  const { computeCapitalAdjustment } = await load();
  const apy = { availableCapital: 500, originalCapital: 1000, currentCapital: 1000 };

  const result = computeCapitalAdjustment(apy, 750);
  assert.equal(result.ok, true);
  assert.deepEqual(result.updates, { depositedCapital: 1250, maxUsdcDeployed: 1250 });
});
