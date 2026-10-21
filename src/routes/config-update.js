// @ts-check
/**
 * Shared config-save boundary. The transport wrappers retain their schemas and
 * response envelopes; this module owns normalization, disk writes and IPC apply.
 */
const {
  getRegimeConfig, getFundConfig, updateFundConfig, productIdMatchesPair,
} = require('../config-utils');
const { validateAndSanitizeRegimeConfig } = require('../config-validator');

// These fields belong to the fund block, but are also part of the engine view.
const FUND_LEVEL_FIELDS = ['dryRun', 'productId'];

const buildClientConfig = (exchange, pair) => {
  const config = { ...getRegimeConfig(exchange, pair) };
  const fundConfig = getFundConfig(exchange, pair);
  for (const field of FUND_LEVEL_FIELDS) config[field] = fundConfig[field];
  return config;
};

/**
 * fullConfig updates have already passed the exchange schema. Regime updates
 * arrive flat. Keep the existing validation precedence and endpoint-specific
 * fund type rules, while sharing the regime and product identity checks.
 */
const prepareConfigUpdate = ({
  exchange, pair, updates, fullConfig = false, rawRegime,
  onDroppedKeys = () => {}, onProductMismatch = () => {},
}) => {
  const fundUpdates = {};
  const rawRegimeUpdates = fullConfig ? rawRegime : {};
  for (const [key, value] of Object.entries(updates)) {
    if (fullConfig || FUND_LEVEL_FIELDS.includes(key)) fundUpdates[key] = value;
    else rawRegimeUpdates[key] = value;
  }

  const validateProduct = () => {
    if (!pair || !fundUpdates.productId) return [];
    const mismatch = productIdMatchesPair(pair, fundUpdates.productId);
    if (mismatch.ok) return [];
    onProductMismatch({ ...mismatch, productId: fundUpdates.productId });
    return [`productId "${fundUpdates.productId}" (${mismatch.incomingBase}) does not match fund ${exchange}/${pair} (${mismatch.pairBase}); a config save cannot change a fund's traded asset`];
  };

  // Full saves have always checked product identity before nested values.
  if (fullConfig) {
    const errors = validateProduct();
    if (errors.length) return { valid: false, errors };
  }

  let regimeUpdates = {};
  let droppedKeys = [];
  if (!fullConfig || rawRegime !== undefined) {
    const result = validateAndSanitizeRegimeConfig(rawRegimeUpdates, getRegimeConfig(exchange, pair));
    droppedKeys = result.droppedKeys;
    // Regime saves log dropped keys even if another known value is invalid.
    if (!fullConfig && droppedKeys.length) onDroppedKeys(droppedKeys);
    if (result.valid === false) return { valid: false, errors: result.errors };
    regimeUpdates = result.value;
    if (fullConfig && droppedKeys.length) onDroppedKeys(droppedKeys);
  }

  if (!fullConfig) {
    if ('dryRun' in fundUpdates && typeof fundUpdates.dryRun !== 'boolean') {
      return { valid: false, errors: ['dryRun must be a boolean'] };
    }
    if ('productId' in fundUpdates && (typeof fundUpdates.productId !== 'string' || !fundUpdates.productId.trim())) {
      return { valid: false, errors: ['productId must be a non-empty string'] };
    }
    const errors = validateProduct();
    if (errors.length) return { valid: false, errors };
  }

  const engineUpdates = { ...regimeUpdates };
  for (const field of FUND_LEVEL_FIELDS) {
    if (field in fundUpdates) engineUpdates[field] = fundUpdates[field];
  }
  return { valid: true, errors: [], fullConfig, fundUpdates, regimeUpdates, droppedKeys, engineUpdates };
};

/**
 * Both transports merge into the stored blocks: a full save carries only the
 * fields the operator changed, so engine-owned regime values it omits (e.g.
 * maxUsdcDeployed credited by a take-profit after the form loaded, optimizer
 * outputs, correction metadata) are never reverted to a stale draft (#1395).
 * Disk errors propagate; only an IPC failure is persisted-but-not-applied.
 */
const persistConfigUpdate = async (exchange, pair, prepared, ipc, onPersist = () => {}) => {
  const { fullConfig, fundUpdates, regimeUpdates, engineUpdates } = prepared;
  const updates = { ...fundUpdates };
  if (Object.keys(regimeUpdates).length) updates.regime = regimeUpdates;
  if (Object.keys(updates).length) updateFundConfig(exchange, pair, updates);
  onPersist();
  // The regime response snapshots its merged GET view before the IPC request.
  const config = fullConfig ? undefined : buildClientConfig(exchange, pair);
  if (!fullConfig || Object.keys(engineUpdates).length) {
    try {
      const result = await ipc.request('regime:update-config', engineUpdates, exchange, pair);
      if (result?.success === false) throw new Error(result.error || result.message || 'Engine rejected config update');
    } catch (err) {
      return { persisted: true, applied: false, error: err.message, config };
    }
  }
  return { persisted: true, applied: true, config };
};

module.exports = { prepareConfigUpdate, persistConfigUpdate, buildClientConfig };
