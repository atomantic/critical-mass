// @ts-check
/**
 * Auto-Aggressiveness (Phase 3): smooth entry-size multiplier from the
 * depression score, dampened by a capital governor.
 * See docs/auto-aggressiveness.md.
 */

/** Narrow initial range around the moderate baseline; widen only as trust grows. */
const DEFAULT_MIN_MULT = 0.5;
const DEFAULT_MAX_MULT = 1.5;
/** Deployed fraction where the boost starts fading / is fully removed. */
const DEFAULT_GOVERNOR_START = 0.4;
const DEFAULT_GOVERNOR_END = 0.9;

const NEUTRAL = Object.freeze({
  active: false, multiplier: 1, raw: 1, governor: 1, deployedRatio: 0, score: 0,
});

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Capital governor: 1 at or below `start` deployed, linearly falling to 0 at or above `end`.
 * @param {number} deployedRatio - deployed capital / total capital
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
const capitalGovernor = (deployedRatio, start, end) => {
  if (!Number.isFinite(deployedRatio) || deployedRatio <= start) return 1;
  if (deployedRatio >= end) return 0;
  return 1 - (deployedRatio - start) / (end - start);
};

/**
 * Compute the auto size multiplier.
 *
 * The raw curve maps score 0..1 linearly onto [minMult, maxMult]. The governor
 * scales only the boost above 1.0, so full deployment returns the neutral 1.0
 * (never a bigger buy) while a low score can still shrink size.
 *
 * @param {{
 *   score: number, ready: boolean, deployedRatio: number,
 *   minMult?: number, maxMult?: number, governorStart?: number, governorEnd?: number,
 * }} params
 * @returns {{active: boolean, multiplier: number, raw: number, governor: number, deployedRatio: number, score: number}}
 */
const computeAutoSizeMultiplier = (params) => {
  const { score, ready, deployedRatio } = params;
  if (!ready || !Number.isFinite(score)) return { ...NEUTRAL };

  const minMult = params.minMult ?? DEFAULT_MIN_MULT;
  const maxMult = Math.max(minMult, params.maxMult ?? DEFAULT_MAX_MULT);
  const start = params.governorStart ?? DEFAULT_GOVERNOR_START;
  const end = Math.max(start + 0.01, params.governorEnd ?? DEFAULT_GOVERNOR_END);

  const raw = minMult + clamp(score, 0, 1) * (maxMult - minMult);
  const ratio = Number.isFinite(deployedRatio) ? Math.max(0, deployedRatio) : 1;
  const governor = capitalGovernor(ratio, start, end);
  const governed = raw > 1 ? 1 + (raw - 1) * governor : raw;
  // The governor may remove the whole boost, so the floor never exceeds neutral even when minMult > 1.
  const multiplier = clamp(governed, Math.min(minMult, 1), maxMult);

  return { active: true, multiplier, raw, governor, deployedRatio: ratio, score };
};

module.exports = {
  computeAutoSizeMultiplier,
  capitalGovernor,
  DEFAULT_MIN_MULT,
  DEFAULT_MAX_MULT,
  DEFAULT_GOVERNOR_START,
  DEFAULT_GOVERNOR_END,
};
