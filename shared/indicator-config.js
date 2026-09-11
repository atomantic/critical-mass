// @ts-check
/**
 * Canonical source of truth for indicator identity, weights, and display labels.
 * Shared by the Node server (signal-engine.js, scorecard.js, the backfill replay
 * script, via src/updown/indicator-config.js) and the Vite admin client
 * (ScorecardPanel, ScorecardAnalysis). Adding an indicator here propagates to both.
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
