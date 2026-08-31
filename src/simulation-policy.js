// @ts-check
/**
 * Server-side contract for the read-only simulation endpoints.
 *
 * The admin UI is intentionally convenient, but it is not the security
 * boundary: callers can invoke these routes directly. Keep the optimizer's
 * supported selections and the HTTP validation rules together so a new UI
 * choice cannot accidentally become an unbounded API choice.
 */

const { INTERVAL_DEFINITIONS } = require('./interval-utils');

const BACKTEST_INTERVALS = Object.freeze(Object.keys(INTERVAL_DEFINITIONS));
// Preserve every current Backtest screen preset while applying a history limit
// appropriate to its candle duration instead of one global (and exploitable)
// cardinality cap.
const MAX_INTERVALS_BY_TYPE = Object.freeze({
  '1min': 10080,
  '5min': 105120,
  '10min': 52560,
  '30min': 17520,
  '1hour': 8760,
  '4hour': 2190,
  daily: 1460,
});
const OPTIMIZER_INTERVALS = Object.freeze(['5min', '10min', '30min', '1hour', '4hour', 'daily']);
const OPTIMIZER_MARKUPS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 10]);
const OPTIMIZER_PERIODS = Object.freeze(['30D', '60D', '90D', '1Y']);
const DEFAULT_BUY_AMOUNTS = Object.freeze({
  '5min': 1,
  '10min': 2,
  '30min': 10,
  '1hour': 50,
  '4hour': 100,
  daily: 500,
});

const LIMITS = Object.freeze({
  maxCombinations: 216, // all supported optimizer choices: 6 × 9 × 4
  maxFundSize: 10_000_000,
  maxBuyAmount: 1_000_000,
  maxPercent: 100,
});

const invalid = (error, code = 'INVALID_SIMULATION_REQUEST') => ({ ok: false, error, code });
const valid = (value) => ({ ok: true, value });

const finiteNumber = (value, field, { min, max, defaultValue }) => {
  if (value === undefined) return valid(defaultValue);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return invalid(`${field} must be a finite number between ${min} and ${max}`);
  }
  return valid(value);
};

const positiveInteger = (value, field, defaultValue, max) => {
  if (value === undefined) return valid(defaultValue);
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    return invalid(`${field} must be an integer between 1 and ${max}`);
  }
  return valid(parsed);
};

const enumValue = (value, field, allowed, defaultValue) => {
  const resolved = value === undefined ? defaultValue : value;
  if (typeof resolved !== 'string' || !allowed.includes(resolved)) {
    return invalid(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return valid(resolved);
};

const firstInvalid = (results) => results.find(result => !result.ok) || null;

const validatePriceQuery = (query = {}) => {
  const intervalType = enumValue(query.intervalType, 'intervalType', BACKTEST_INTERVALS, 'daily');
  const intervals = intervalType.ok
    ? positiveInteger(query.intervals, 'intervals', 365, MAX_INTERVALS_BY_TYPE[intervalType.value])
    : intervalType;
  const failure = firstInvalid([intervalType, intervals]);
  return failure || valid({ intervals: intervals.value, intervalType: intervalType.value });
};

const validateBacktestInput = (body = {}) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('request body must be an object');
  const intervalBuyAmount = finiteNumber(body.intervalBuyAmount, 'intervalBuyAmount', { min: 0.01, max: LIMITS.maxBuyAmount, defaultValue: 500 });
  const sellMarkupPercent = finiteNumber(body.sellMarkupPercent, 'sellMarkupPercent', { min: 0, max: LIMITS.maxPercent, defaultValue: 10 });
  const holdbackPercent = finiteNumber(body.holdbackPercent, 'holdbackPercent', { min: 0, max: LIMITS.maxPercent, defaultValue: 5 });
  const feePercent = finiteNumber(body.feePercent, 'feePercent', { min: 0, max: LIMITS.maxPercent, defaultValue: 0.125 });
  const rebatePercent = finiteNumber(body.rebatePercent, 'rebatePercent', { min: 0, max: LIMITS.maxPercent, defaultValue: 0.031 });
  const intervalType = enumValue(body.intervalType, 'intervalType', BACKTEST_INTERVALS, 'daily');
  const intervals = intervalType.ok
    ? positiveInteger(body.intervals, 'intervals', 365, MAX_INTERVALS_BY_TYPE[intervalType.value])
    : intervalType;
  const fundSize = finiteNumber(body.fundSize, 'fundSize', { min: 0, max: LIMITS.maxFundSize, defaultValue: 0 });
  const failure = firstInvalid([intervalBuyAmount, sellMarkupPercent, holdbackPercent, feePercent, rebatePercent, intervals, intervalType, fundSize]);
  return failure || valid({
    intervalBuyAmount: intervalBuyAmount.value,
    sellMarkupPercent: sellMarkupPercent.value,
    holdbackPercent: holdbackPercent.value,
    feePercent: feePercent.value,
    rebatePercent: rebatePercent.value,
    intervals: intervals.value,
    intervalType: intervalType.value,
    fundSize: fundSize.value,
  });
};

const normalizeSelection = (value, field, allowed) => {
  const selected = value === undefined || value === null ? [...allowed] : value;
  if (!Array.isArray(selected) || selected.length === 0 || selected.length > allowed.length) {
    return invalid(`${field} must contain between 1 and ${allowed.length} supported values`);
  }
  if (selected.some(item => !allowed.includes(item)) || new Set(selected).size !== selected.length) {
    return invalid(`${field} must contain unique supported values`);
  }
  return valid(allowed.filter(item => selected.includes(item)));
};

const validateBuyAmounts = (value, selectedIntervals) => {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    return invalid('buyAmounts must be an object keyed by supported interval');
  }
  const supplied = value || {};
  if (Object.keys(supplied).some(key => !OPTIMIZER_INTERVALS.includes(key))) {
    return invalid('buyAmounts contains an unsupported interval');
  }
  const amounts = { ...DEFAULT_BUY_AMOUNTS };
  for (const [interval, amount] of Object.entries(supplied)) {
    const checked = finiteNumber(amount, `buyAmounts.${interval}`, { min: 0.01, max: LIMITS.maxBuyAmount, defaultValue: amounts[interval] });
    if (!checked.ok) return checked;
    amounts[interval] = checked.value;
  }
  return valid(Object.fromEntries(selectedIntervals.map(interval => [interval, amounts[interval]])));
};

const validateOptimizerInput = (body = {}) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('request body must be an object');
  if (body.forceRefresh !== undefined && typeof body.forceRefresh !== 'boolean') return invalid('forceRefresh must be a boolean');
  const fundSize = finiteNumber(body.fundSize, 'fundSize', { min: 0, max: LIMITS.maxFundSize, defaultValue: 10000 });
  const intervals = normalizeSelection(body.intervals, 'intervals', OPTIMIZER_INTERVALS);
  const markups = normalizeSelection(body.markups, 'markups', OPTIMIZER_MARKUPS);
  const periods = normalizeSelection(body.periods, 'periods', OPTIMIZER_PERIODS);
  const failure = firstInvalid([fundSize, intervals, markups, periods]);
  if (failure) return failure;
  const combinations = intervals.value.length * markups.value.length * periods.value.length;
  if (combinations > LIMITS.maxCombinations) return invalid(`optimizer request exceeds ${LIMITS.maxCombinations} combinations`);
  const buyAmounts = validateBuyAmounts(body.buyAmounts, intervals.value);
  if (!buyAmounts.ok) return buyAmounts;
  return valid({
    fundSize: fundSize.value,
    forceRefresh: body.forceRefresh === true,
    intervals: intervals.value,
    markups: markups.value,
    periods: periods.value,
    buyAmounts: buyAmounts.value,
    combinations,
  });
};

const normalizeOptimizerConfig = (config = {}) => {
  const normalized = validateOptimizerInput(config);
  if (!normalized.ok) return null;
  const { intervals, markups, periods, buyAmounts } = normalized.value;
  return { intervals, markups, periods, buyAmounts };
};

const optimizerRequestKey = ({ exchange, pair, productId, ...config }) => JSON.stringify({
  exchange,
  pair,
  productId,
  ...config,
});

module.exports = {
  BACKTEST_INTERVALS,
  MAX_INTERVALS_BY_TYPE,
  OPTIMIZER_INTERVALS,
  OPTIMIZER_MARKUPS,
  OPTIMIZER_PERIODS,
  DEFAULT_BUY_AMOUNTS,
  LIMITS,
  validatePriceQuery,
  validateBacktestInput,
  validateOptimizerInput,
  normalizeOptimizerConfig,
  optimizerRequestKey,
};
