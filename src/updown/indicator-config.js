// @ts-check
/**
 * Single source of truth for indicator identity, weights, and display labels.
 * Imported by signal-engine.js (scoring), scorecard.js (accuracy tracking),
 * and the backfill replay script. Keeping these in one place prevents the
 * three modules from silently drifting apart when a new indicator is added.
 */

const INDICATORS = ['rsi', 'stochastic', 'macd', 'bollinger', 'vwap', 'momentum', 'obv', 'williamsR', 'cci'];

const INDICATOR_WEIGHTS = {
  rsi: 0.10,
  stochastic: 0.08,
  macd: 0.22,
  bollinger: 0.07,
  vwap: 0.08,
  momentum: 0.15,
  obv: 0.17,
  williamsR: 0.06,
  cci: 0.07,
};

const INDICATOR_LABELS = {
  rsi: 'RSI',
  stochastic: 'Stoch',
  macd: 'MACD',
  bollinger: 'Bollinger',
  vwap: 'VWAP',
  momentum: 'Momentum',
  obv: 'OBV',
  williamsR: 'Will %R',
  cci: 'CCI',
};

module.exports = {
  INDICATORS,
  INDICATOR_WEIGHTS,
  INDICATOR_LABELS,
};
