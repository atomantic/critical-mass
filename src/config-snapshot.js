// @ts-check
/**
 * Configuration archive snapshot (issue #430)
 *
 * Split out of config-utils.js (issue #727) so that file stops mixing file
 * IO/mtime cache, fund topology, per-domain getters/setters, and regime
 * value rules with this archive-only concern. config-utils.js re-exports
 * every name below for backward compatibility with existing callers
 * (backup-service.js, tests/backup-config-portability.test.js).
 *
 * data/config.json holds only the DIFF against the machine-local base
 * config.json (or, on a fresh clone, the shipped config.example.json). An
 * archive of the data directory alone therefore carries no fund identity at
 * all when the operator's funds are defined in the base file: restoring onto a
 * new machine silently adopts the destination's base — a different pair and a
 * different allocation — while the restored state files describe the original
 * fund.
 *
 * The archive fixes that by carrying a self-contained, schema-allowlisted
 * snapshot of the EFFECTIVE configuration (every value already materialized,
 * so it does not depend on any base file), which restore replays against
 * whatever base the destination has.
 */

const { isDeepStrictEqual } = require('util');
const {
  DEFAULTS,
  GLOBAL_DEFAULTS,
  REGIME_DEFAULTS,
  normalizeToMultiExchange,
  normalizeExchangeBlock,
  resolveFundConfig,
  resolveRegimeConfig,
  computeDiff,
  deepMerge,
  DELETED_PAIRS_KEY,
  PAIR_RE,
} = require('./config-utils');

/**
 * Snapshot SHAPE version. Bump only for a breaking shape change — a field
 * removed, re-typed, or moved. Additive growth of the allowlists below does
 * NOT move it; that is what `CONFIG_SNAPSHOT_FIELD_REVISION` is for (#567).
 */
const CONFIG_SNAPSHOT_VERSION = 1;

/**
 * Fund-level fields carried by a snapshot. Allowlisted from the fund schema so
 * a stray/unknown key on disk — or a crafted archive — can never smuggle a
 * credential through the snapshot.
 */
const SNAPSHOT_FUND_KEYS = Object.freeze(Object.keys(DEFAULTS));

/** Regime (strategy) fields carried by a snapshot. */
const SNAPSHOT_REGIME_KEYS = Object.freeze(Object.keys(REGIME_DEFAULTS));

/**
 * Global fields carried by a snapshot.
 *
 * Deliberately EXCLUDES `notifications` and `sentinel`: those hold the Telegram
 * bot token and the AI-classification credentials. Restore leaves the
 * destination's own copies of both untouched.
 */
const SNAPSHOT_GLOBAL_KEYS = Object.freeze([
  ...Object.keys(GLOBAL_DEFAULTS),
  'aggressivenessPresets',
]);

/**
 * Snapshot FIELD revision: how many fields the three allowlists above carry.
 *
 * The allowlists are derived from the live defaults objects, so they widen on
 * every ordinary feature commit while `CONFIG_SNAPSHOT_VERSION` deliberately
 * stays put. Without a second marker a reader cannot tell "a version-1 payload
 * written by a newer build" from "a version-1 payload it fully understands",
 * so it took the strict-rejection path meant for crafted archives and refused
 * the whole restore over one unknown knob (#567).
 *
 * Written as a literal, not computed from the lists, so the test that asserts
 * it equals `SNAPSHOT_FUND_KEYS.length + SNAPSHOT_REGIME_KEYS.length +
 * SNAPSHOT_GLOBAL_KEYS.length` fails CI the moment a field is added to
 * DEFAULTS / REGIME_DEFAULTS / GLOBAL_DEFAULTS without bumping it.
 */
const CONFIG_SNAPSHOT_FIELD_REVISION = 115;

/**
 * Copy only the allowlisted, defined keys of `source`, in allowlist order (so
 * two snapshots of equal content are structurally identical).
 * @param {Object|undefined} source
 * @param {ReadonlyArray<string>} keys
 * @returns {Object}
 */
const pickAllowed = (source, keys) => {
  const out = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) out[key] = source[key];
  }
  return out;
};

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Build a self-contained snapshot of the effective non-secret configuration.
 *
 * @param {Object} config - A full (already merged) configuration object
 * @returns {{version: number, fieldRevision: number, exchanges: Object, global: Object}} Snapshot
 */
const buildConfigSnapshot = (config) => {
  const normalized = normalizeToMultiExchange(isPlainObject(config) ? config : {});
  const exchanges = {};
  for (const [exchange, block] of Object.entries(normalized.exchanges || {})) {
    const pairs = {};
    for (const [pair, fundBlock] of Object.entries(normalizeExchangeBlock(block).pairs || {})) {
      const fund = pickAllowed(resolveFundConfig(normalized.global, fundBlock), SNAPSHOT_FUND_KEYS);
      // The pair key IS the fund identity; never let it drift from productId.
      fund.productId = fundBlock?.productId ?? pair;
      fund.regime = pickAllowed(resolveRegimeConfig(fundBlock), SNAPSHOT_REGIME_KEYS);
      pairs[pair] = fund;
    }
    // An exchange with no live funds is represented by its absence, which is
    // what reconstruction tombstones against the destination base.
    if (Object.keys(pairs).length > 0) exchanges[exchange] = { pairs };
  }
  return {
    version: CONFIG_SNAPSHOT_VERSION,
    fieldRevision: CONFIG_SNAPSHOT_FIELD_REVISION,
    exchanges,
    global: pickAllowed(normalized.global, SNAPSHOT_GLOBAL_KEYS),
  };
};

/**
 * Schema-validate a snapshot read back out of an archive.
 *
 * Two markers gate a cross-build read (#567). `version` is the SHAPE contract:
 * a mismatch is fatal because the reader cannot interpret the payload at all.
 * `fieldRevision` is the ALLOWLIST contract, and it moves on every ordinary
 * commit that adds a config field — so a payload whose revision is strictly
 * GREATER than this build's was written by a newer build, and a key this build
 * does not recognize is simply a setting that did not exist here yet: drop it
 * (the destination falls back to its own default for it) and report it in
 * `droppedFields`. That mirrors the round-trip tolerance `sanitizeRegimeConfig`
 * already applies to stored regime blocks. At an equal or older revision an
 * unknown key is still a crafted or corrupt archive, and still fatal.
 *
 * Dropped, never passed through: the returned `snapshot` is the sanitized copy
 * `reconstructConfigOverride` replays into data/config.json, so the allowlist's
 * secret-smuggling guard holds in the forward direction too.
 *
 * @param {*} snapshot - Untrusted snapshot from an archive manifest
 * @returns {{valid: true, snapshot: Object, droppedFields: Array<string>}
 *   | {valid: false, error: string}}
 */
const validateConfigSnapshot = (snapshot) => {
  if (!isPlainObject(snapshot)) {
    return { valid: false, error: 'configuration snapshot is missing or is not an object' };
  }
  if (snapshot.version !== CONFIG_SNAPSHOT_VERSION) {
    return {
      valid: false,
      error: `configuration snapshot version ${JSON.stringify(snapshot.version)} is not supported by this build (expected ${CONFIG_SNAPSHOT_VERSION}) — upgrade critical-mass before restoring this archive`,
    };
  }
  if (!isPlainObject(snapshot.exchanges)) {
    return { valid: false, error: 'configuration snapshot has no `exchanges` object' };
  }
  if (snapshot.global !== undefined && !isPlainObject(snapshot.global)) {
    return { valid: false, error: 'configuration snapshot `global` is not an object' };
  }

  // A missing/non-integer marker is an archive from before this contract
  // existed: revision 0, strict. Only a STRICTLY newer revision earns tolerance.
  const payloadRevision = Number.isInteger(snapshot.fieldRevision) ? snapshot.fieldRevision : 0;
  const fromNewerBuild = payloadRevision > CONFIG_SNAPSHOT_FIELD_REVISION;

  const sanitized = structuredClone(snapshot);
  /** @type {Array<string>} */
  const droppedFields = [];
  /**
   * Handle one unknown key: drop it from the sanitized copy when the payload
   * comes from a newer build, otherwise hand back the fatal error to return.
   * @param {Object} container - Object in `sanitized` holding the key
   * @param {string} key
   * @param {string} fieldPath - Reporting path, e.g. `coinbase/BTC-USDC.regime.foo`
   * @param {string} error - Fatal message when tolerance does not apply
   * @returns {string|null}
   */
  const dropOrReject = (container, key, fieldPath, error) => {
    if (!fromNewerBuild) return error;
    delete container[key];
    droppedFields.push(fieldPath);
    return null;
  };

  for (const key of Object.keys(sanitized.global || {})) {
    if (SNAPSHOT_GLOBAL_KEYS.includes(key)) continue;
    const fatal = dropOrReject(sanitized.global, key, `global.${key}`, `configuration snapshot carries unsupported global field "${key}"`);
    if (fatal) return { valid: false, error: fatal };
  }
  const allowedFundKeys = new Set([...SNAPSHOT_FUND_KEYS, 'regime']);
  for (const [exchange, block] of Object.entries(sanitized.exchanges)) {
    if (!isPlainObject(block) || !isPlainObject(block.pairs)) {
      return { valid: false, error: `configuration snapshot entry for exchange "${exchange}" has no \`pairs\` object` };
    }
    for (const [pair, fund] of Object.entries(block.pairs)) {
      if (!PAIR_RE.test(pair)) {
        return { valid: false, error: `configuration snapshot has an invalid pair identifier "${exchange}/${pair}"` };
      }
      if (!isPlainObject(fund)) {
        return { valid: false, error: `configuration snapshot fund "${exchange}/${pair}" is not an object` };
      }
      if (typeof fund.productId !== 'string' || !fund.productId) {
        return { valid: false, error: `configuration snapshot fund "${exchange}/${pair}" has no productId` };
      }
      for (const key of Object.keys(fund)) {
        if (allowedFundKeys.has(key)) continue;
        const fatal = dropOrReject(fund, key, `${exchange}/${pair}.${key}`, `configuration snapshot fund "${exchange}/${pair}" carries unsupported field "${key}"`);
        if (fatal) return { valid: false, error: fatal };
      }
      if (fund.regime !== undefined) {
        if (!isPlainObject(fund.regime)) {
          return { valid: false, error: `configuration snapshot fund "${exchange}/${pair}" has a non-object regime block` };
        }
        for (const key of Object.keys(fund.regime)) {
          if (SNAPSHOT_REGIME_KEYS.includes(key)) continue;
          const fatal = dropOrReject(fund.regime, key, `${exchange}/${pair}.regime.${key}`, `configuration snapshot fund "${exchange}/${pair}" carries unsupported regime field "${key}"`);
          if (fatal) return { valid: false, error: fatal };
        }
      }
    }
  }
  return { valid: true, snapshot: sanitized, droppedFields };
};

/**
 * Resolution a merged config would produce for one fund if the override
 * carried NOTHING for it. Used to drop redundant keys from the reconstructed
 * override so a restore doesn't freeze a fully-materialized copy of every
 * setting into data/config.json (which would then shadow later edits to the
 * base config.json).
 *
 * Note the base's LEGACY-FLAT fields are deliberately ignored: the
 * reconstructed block always carries a `pairs` map, and `normalizeExchangeBlock`
 * only synthesizes a fund from flat fields when there is no `pairs` map at all.
 *
 * @param {Object|null} baseBlock - Destination base block for the exchange
 * @param {string} pair
 * @param {Object} globalConfig - The reconstructed `global` block
 * @returns {{fund: Object, regime: Object}}
 */
const resolveOverrideBaseline = (baseBlock, pair, globalConfig) => {
  const basePair = isPlainObject(baseBlock?.pairs) ? baseBlock.pairs[pair] : undefined;
  return {
    fund: resolveFundConfig(globalConfig, basePair),
    regime: resolveRegimeConfig(basePair),
  };
};

/**
 * Strip fund/regime keys the destination would resolve to the same value
 * anyway. Verified by the caller — on any mismatch the unpruned target wins.
 * @param {Object} target - Full reconstructed configuration
 * @param {Object} base - Destination base configuration
 * @returns {Object} Pruned clone of `target`
 */
const minimizeReconstructedTarget = (target, base) => {
  const pruned = structuredClone(target);
  for (const [exchange, block] of Object.entries(pruned.exchanges || {})) {
    const baseBlock = isPlainObject(base.exchanges?.[exchange]) ? base.exchanges[exchange] : null;
    for (const [pair, fund] of Object.entries(block.pairs || {})) {
      const baseline = resolveOverrideBaseline(baseBlock, pair, pruned.global);
      for (const key of Object.keys(fund)) {
        if (key !== 'regime' && key !== 'productId' && isDeepStrictEqual(fund[key], baseline.fund[key])) delete fund[key];
      }
      for (const key of Object.keys(fund.regime || {})) {
        if (isDeepStrictEqual(fund.regime[key], baseline.regime[key])) delete fund.regime[key];
      }
      if (fund.regime && Object.keys(fund.regime).length === 0) delete fund.regime;
    }
  }
  return pruned;
};

/**
 * Rebuild the base-relative override file (data/config.json) that makes the
 * DESTINATION reproduce the archived configuration.
 *
 * Pure — computes and verifies the result in memory so the caller can abort
 * before mutating anything on the destination.
 *
 * @param {Object} args
 * @param {*} args.snapshot - Snapshot from the archive manifest (validated here)
 * @param {Object} [args.baseConfig] - Destination's raw base config.json contents
 * @param {Object} [args.destinationGlobal] - Destination's effective `global` block,
 *   read BEFORE the restore, so its credentials (Telegram, Sentinel) survive.
 * @returns {{ok: true, override: Object, droppedFields: Array<string>}
 *   | {ok: false, error: string}}
 */
const reconstructConfigOverride = ({ snapshot: archivedSnapshot, baseConfig, destinationGlobal }) => {
  const validation = validateConfigSnapshot(archivedSnapshot);
  if (!validation.valid) return { ok: false, error: validation.error };
  // Start with the sanitized archive and materialize this build's defaults
  // for settings added since it was written. Older version-1 archives lack
  // those keys; comparing them directly with a newly materialized snapshot
  // otherwise rejects every restore after an additive default is introduced.
  // Archived values still win, and unknown newer-build fields were already
  // dropped above before any reconstruction can persist them (#567).
  const { droppedFields } = validation;
  const snapshot = buildConfigSnapshot(validation.snapshot);

  const base = isPlainObject(baseConfig) ? baseConfig : {};
  const target = structuredClone(base);
  target.exchanges = { ...(base.exchanges || {}) };

  const exchanges = new Set([...Object.keys(base.exchanges || {}), ...Object.keys(snapshot.exchanges)]);
  for (const exchange of exchanges) {
    const baseBlock = isPlainObject(base.exchanges?.[exchange]) ? base.exchanges[exchange] : null;
    const snapshotPairs = snapshot.exchanges[exchange]?.pairs || {};
    // computeDiff only emits keys present in the target, so a pair the base
    // defines but the source did not would merge straight back in. Tombstone it
    // instead — the same mechanism fund deletion uses (#441).
    // Deliberately the RAW base pairs map, not diffSnapshotAgainstConfig below:
    // an already-tombstoned pair must stay tombstoned even though normalized
    // reads (and buildConfigSnapshot) filter it out, or this would silently
    // undelete it the next time an archive lacking it is restored.
    const basePairs = isPlainObject(baseBlock?.pairs) ? Object.keys(baseBlock.pairs) : [];
    const tombstones = basePairs.filter((pair) => !(pair in snapshotPairs));
    const block = { ...(baseBlock || {}), pairs: structuredClone(snapshotPairs) };
    if (tombstones.length > 0 || (Array.isArray(baseBlock?.[DELETED_PAIRS_KEY]) && baseBlock[DELETED_PAIRS_KEY].length > 0)) {
      block[DELETED_PAIRS_KEY] = tombstones;
    } else {
      delete block[DELETED_PAIRS_KEY];
    }
    target.exchanges[exchange] = block;
  }

  // Non-secret globals come from the archive; everything else (notifications,
  // sentinel) stays on the destination's own effective values.
  target.global = deepMerge(
    isPlainObject(destinationGlobal) ? destinationGlobal : (base.global || {}),
    snapshot.global || {},
  );

  // Prove the round trip before the caller writes anything: replay each
  // candidate override through the exact merge+normalize path loadConfig uses
  // and re-derive a snapshot from it. Any drift (a base pair that survived, a
  // value the diff failed to carry) is caught here instead of silently trading
  // the wrong fund. The minimized candidate is preferred so the override file
  // stays a diff; the fully-materialized one is the fallback that always works.
  const reproduces = (candidate) =>
    isDeepStrictEqual(buildConfigSnapshot(deepMerge(base, candidate)).exchanges, snapshot.exchanges);

  for (const candidate of [minimizeReconstructedTarget(target, base), target]) {
    const override = computeDiff(base, candidate);
    if (reproduces(override)) return { ok: true, override, droppedFields };
  }

  const describe = (entry) => Object.keys(entry || {}).sort().join(', ') || 'none';
  const reproduced = buildConfigSnapshot(deepMerge(base, computeDiff(base, target)));
  return {
    ok: false,
    error: `restored configuration would not reproduce the archived funds (archived: ${describe(snapshot.exchanges)}; reconstructed: ${describe(reproduced.exchanges)}) — destination config left unchanged`,
  };
};

/**
 * Diff an archive snapshot against a full (already-merged) destination
 * configuration, returning every EFFECTIVE fund the destination currently
 * runs that the snapshot does not carry — i.e. what restoring `snapshot`
 * onto `effectiveConfig` would remove.
 *
 * Effective, not base-only: a fund defined only in the override
 * (data/config.json) disappears from a restore just as completely as a
 * base-defined one, because reconstructConfigOverride above replaces the
 * override's `pairs` map wholesale rather than merging it. Reporting must
 * cover both, or an override-only fund vanishes with no warning (issue #533).
 *
 * @param {Object} args
 * @param {*} args.snapshot - Snapshot from the archive manifest
 * @param {Object} args.effectiveConfig - Destination's full merged (base + override) configuration
 * @returns {Array<{exchange: string, pair: string, fund: Object}>}
 */
const diffSnapshotAgainstConfig = ({ snapshot, effectiveConfig }) => {
  const effectiveSnapshot = buildConfigSnapshot(effectiveConfig);
  const removed = [];
  for (const [exchange, block] of Object.entries(effectiveSnapshot.exchanges || {})) {
    const snapshotPairs = isPlainObject(snapshot?.exchanges?.[exchange]?.pairs) ? snapshot.exchanges[exchange].pairs : {};
    for (const [pair, fund] of Object.entries(block.pairs || {})) {
      if (!(pair in snapshotPairs)) removed.push({ exchange, pair, fund });
    }
  }
  return removed;
};

module.exports = {
  CONFIG_SNAPSHOT_VERSION,
  CONFIG_SNAPSHOT_FIELD_REVISION,
  // Exported so a test can assert the field revision still matches the
  // allowlists it describes (#567).
  SNAPSHOT_FUND_KEYS,
  SNAPSHOT_REGIME_KEYS,
  SNAPSHOT_GLOBAL_KEYS,
  buildConfigSnapshot,
  validateConfigSnapshot,
  reconstructConfigOverride,
  diffSnapshotAgainstConfig,
};
