/**
 * Single source of truth for indicator identity, weights, and display labels.
 * Shared between server (signal-engine.js, scorecard.js) and admin client (ScorecardPanel, ScorecardAnalysis).
 */

export const INDICATORS = ['rsi', 'stochastic', 'macd', 'bollinger', 'vwap', 'momentum', 'obv', 'williamsR', 'cci'];

export const INDICATOR_WEIGHTS = {
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

export const INDICATOR_LABELS = {
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
