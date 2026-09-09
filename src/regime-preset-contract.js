// @ts-check
/**
 * Pure aggressiveness preset contract. No persistence, logging, or runtime imports.
 * config-utils re-exports the existing public constants for compatibility.
 */

const MERGE_PROXIMITY_BOUNDS = { min: 0.25, max: 3.0, default: 1.0 };

/**
 * Default aggressiveness preset definitions
 * These define the parameter values for each aggressiveness level.
 *
 * Momentum offsets follow the documented DEFAULTS ratio (up = 0.5x neutral,
 * down = 1.5x neutral) — before they were preset-scaled, every level inherited
 * the global 5/15 defaults, so a conservative fund with up-momentum bid
 * TIGHTER (5bps) than its own neutral offset (25bps), inverting the intent.
 *
 * orderStaleMs is the FLOOR for the ATR-adaptive per-order stale timeout
 * (see computeAdaptiveStaleMs) and scales with the offset: a 25bps bid needs
 * far longer for price to plausibly reach it than a 5bps bid (empirically
 * ~1% vs ~40% fill within 2min at median BTC vol).
 */
const DEFAULT_AGGRESSIVENESS_PRESETS = {
  conservative: {
    kFactor: 0.8,
    minIntervalMs: 180000,
    maxIntervalMs: 7200000,
    entryOffsetBps: 25,
    entryOffsetUpBps: 13,
    entryOffsetDownBps: 38,
    orderStaleMs: 300000,
    cautionScale: 0.15,
    trendScale: 0,
    maxCycleBuys: 10,
    mergeProximityScale: 0.5,
  },
  moderate: {
    kFactor: 0.65,
    minIntervalMs: 120000,
    maxIntervalMs: 3600000,
    entryOffsetBps: 18,
    entryOffsetUpBps: 9,
    entryOffsetDownBps: 27,
    orderStaleMs: 180000,
    cautionScale: 0.35,
    trendScale: 0.1,
    maxCycleBuys: 15,
    mergeProximityScale: 1.0,
  },
  aggressive: {
    kFactor: 0.5,
    minIntervalMs: 90000,
    maxIntervalMs: 2400000,
    entryOffsetBps: 12,
    entryOffsetUpBps: 6,
    entryOffsetDownBps: 18,
    orderStaleMs: 120000,
    cautionScale: 0.6,
    trendScale: 0.25,
    maxCycleBuys: 25,
    mergeProximityScale: 1.5,
  },
  maximum: {
    kFactor: 0.3,
    minIntervalMs: 60000,
    maxIntervalMs: 1200000,
    entryOffsetBps: 5,
    entryOffsetUpBps: 3,
    entryOffsetDownBps: 8,
    orderStaleMs: 60000,
    cautionScale: 1.0,
    trendScale: 0.5,
    maxCycleBuys: 50,
    mergeProximityScale: 2.5,
  },
};

// Canonical keys come from every declaration, never from the validation schema.
const PRESET_KEYS = [...new Set(Object.values(DEFAULT_AGGRESSIVENESS_PRESETS).flatMap(Object.keys))];

// Shared by preset saves and fund application. Use the stricter existing bounds
// wherever the two paths previously disagreed.
const PRESET_FIELD_RULES = {
  kFactor: { type: 'number', min: 0.2, max: 0.8 },
  minIntervalMs: { type: 'number', min: 30000, max: 3600000 },
  maxIntervalMs: { type: 'number', min: 1000, max: 14400000 },
  entryOffsetBps: { type: 'number', min: 0, max: 1000 },
  entryOffsetUpBps: { type: 'number', min: 0, max: 1000 },
  entryOffsetDownBps: { type: 'number', min: 0, max: 1000 },
  orderStaleMs: { type: 'number', min: 5000, max: 3600000 },
  cautionScale: { type: 'number', min: 0, max: 10 },
  trendScale: { type: 'number', min: 0, max: 10 },
  maxCycleBuys: { type: 'number', min: 3, max: 1000 },
  mergeProximityScale: { type: 'number', min: MERGE_PROXIMITY_BOUNDS.min, max: MERGE_PROXIMITY_BOUNDS.max },
};

// Historical schema-only fields remain accepted for stored override compatibility;
// they do not define canonical preset coverage or add new fund fields.
const LEGACY_PRESET_FIELD_RULES = {
  targetMarkup: { type: 'number', min: 0, max: 1 },
  minMarkup: { type: 'number', min: 0, max: 1 },
  maxMarkup: { type: 'number', min: 0, max: 1 },
  sizeMultiplier: { type: 'number', min: 0.1, max: 10 },
};

module.exports = {
  DEFAULT_AGGRESSIVENESS_PRESETS,
  MERGE_PROXIMITY_BOUNDS,
  PRESET_KEYS,
  PRESET_FIELD_RULES,
  LEGACY_PRESET_FIELD_RULES,
};
