// @ts-check
/**
 * Shared sizing contract (dependency-free).
 *
 * One definition of the permissible values for the sizing settings that are
 * written by BOTH manual saves (config-validator) and the automatic size
 * optimizer (size-optimizer -> regime-engine.handleSizeAdjustment).
 *
 * - baseSizeUsdc: 1..2000 (matches the optimizer's maximum sizeAbsoluteMaxBase).
 * - maxUsdcDeployed: any finite value >= 0. The optimizer derives it from the
 *   available wallet balance, so a low-balance wallet legitimately yields a cap
 *   below 1000; it must never be inflated to misrepresent funded capacity. A
 *   zero cap simply blocks positive-cost entries downstream.
 */

const BASE_SIZE_USDC_BOUNDS = Object.freeze({ min: 1, max: 2000 });
const MAX_USDC_DEPLOYED_MIN = 0;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** @returns {string|null} error message or null when valid */
const validateBaseSizeUsdc = (value) => (
  isFiniteNumber(value) && value >= BASE_SIZE_USDC_BOUNDS.min && value <= BASE_SIZE_USDC_BOUNDS.max
    ? null
    : `baseSizeUsdc must be between ${BASE_SIZE_USDC_BOUNDS.min} and ${BASE_SIZE_USDC_BOUNDS.max}`
);

/** @returns {string|null} error message or null when valid */
const validateMaxUsdcDeployed = (value) => (
  isFiniteNumber(value) && value >= MAX_USDC_DEPLOYED_MIN
    ? null
    : 'maxUsdcDeployed must be a finite number >= 0'
);

/**
 * Validate the sizing fields of an automatic adjustment.
 * @param {{baseSizeUsdc?: number, maxUsdcDeployed?: number}} fields
 * @returns {string[]}
 */
const validateSizingFields = (fields) => [
  validateBaseSizeUsdc(fields.baseSizeUsdc),
  validateMaxUsdcDeployed(fields.maxUsdcDeployed),
].filter(Boolean);

module.exports = {
  BASE_SIZE_USDC_BOUNDS,
  MAX_USDC_DEPLOYED_MIN,
  validateBaseSizeUsdc,
  validateMaxUsdcDeployed,
  validateSizingFields,
};
