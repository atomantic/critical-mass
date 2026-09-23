// Pure capital-adjustment math for RegimeDashboard's "Available capital"
// form (issue #701).
//
// handleCapitalAdjust turns the operator's typed "available" figure into a
// depositedCapital/maxUsdcDeployed delta, then silently clamped the computed
// values to their valid minimums (depositedCapital: 0 or >= 100;
// maxUsdcDeployed: >= 1000) while the toast reported the full, unclamped
// delta the operator typed — so the UI said one thing while the server
// received (and the APY denominator used) another.
//
// This module computes the raw (unclamped) values and reports when they
// would actually need clamping, so the caller can block the save with an
// explicit error instead of silently rewriting the numbers. Writing exactly
// 0 for depositedCapital is the intentional "auto-derive" sentinel (see
// regime-engine.js's config.depositedCapital handling) and is never blocked.

const EPSILON = 1e-6
const closeEnough = (a, b) => Math.abs(a - b) < EPSILON

/**
 * @param {{availableCapital?: number, depositedCapital?: number, originalCapital?: number,
 *   initialCapital?: number, maxUsdcDeployed?: number, currentCapital?: number}} apy
 * @param {number} newAvailable - the operator's typed target "available capital"
 * @returns {{ok: false, error: string} |
 *   {ok: true, noop: true, delta: 0} |
 *   {ok: true, noop: false, delta: number, updates: {depositedCapital: number, maxUsdcDeployed: number}}}
 */
export function computeCapitalAdjustment(apy, newAvailable) {
  if (typeof newAvailable !== 'number' || Number.isNaN(newAvailable) || newAvailable < 0) {
    return { ok: false, error: 'Enter a valid positive number' }
  }

  const currentAvailable = apy?.availableCapital || 0
  const delta = newAvailable - currentAvailable
  if (Math.abs(delta) < 0.01) {
    return { ok: true, noop: true, delta: 0 }
  }

  const currentDeposited = apy?.depositedCapital || apy?.originalCapital || apy?.initialCapital || 0
  const currentMax = apy?.maxUsdcDeployed || apy?.currentCapital || 0
  const rawDeposited = currentDeposited + delta
  const rawMax = currentMax + delta

  const clampedDeposited = rawDeposited < 100 ? 0 : rawDeposited
  if (!closeEnough(clampedDeposited, rawDeposited)) {
    return {
      ok: false,
      error: `Would set deposited capital to $${rawDeposited.toFixed(2)} — must be $0 (auto-derive) or at least $100. Adjust to a smaller change or drop all the way to $0.`,
    }
  }

  const clampedMax = Math.max(1000, rawMax)
  if (!closeEnough(clampedMax, rawMax)) {
    return {
      ok: false,
      error: `Would drop max deployed capital to $${rawMax.toFixed(2)} — the minimum is $1000.`,
    }
  }

  return {
    ok: true,
    noop: false,
    delta,
    updates: { depositedCapital: rawDeposited, maxUsdcDeployed: rawMax },
  }
}
