// @ts-check
/**
 * Server-side re-exports of the canonical indicator catalog.
 * Canonical implementation lives in shared/indicator-config.js so the Vite
 * admin client consumes the same identity, weights, and labels.
 */

const {
  INDICATORS,
  INDICATOR_WEIGHTS,
  INDICATOR_LABELS,
} = require('../../shared/indicator-config');

module.exports = {
  INDICATORS,
  INDICATOR_WEIGHTS,
  INDICATOR_LABELS,
};
