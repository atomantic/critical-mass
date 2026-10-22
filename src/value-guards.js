/**
 * Value Guards
 *
 * Dependency-free type-guard and rounding helpers. Kept out of shared-utils
 * because that module pulls in state-tracker/logger, which transitively
 * require config modules that would then form a require cycle.
 */

/** True for non-null, non-array objects. */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** True only for number-typed finite values (no string coercion). */
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Round to 2 decimal places. */
const round2 = (n) => Math.round(n * 100) / 100;

module.exports = { isPlainObject, isFiniteNumber, round2 };
