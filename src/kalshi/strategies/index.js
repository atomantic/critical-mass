/**
 * Strategy Registry
 * Central registration and management of all trading strategies
 */

const SettlementSniperStrategy = require('./crypto/settlement-sniper.js')
const CoinbaseFairValueStrategy = require('./crypto/coinbase-fair-value.js')
const MomentumRiderStrategy = require('./crypto/momentum-rider.js')
const GammaScalperStrategy = require('./crypto/gamma-scalper.js')
const SwingFlipperStrategy = require('./crypto/swing-flipper.js')
const BaseStrategy = require('./base-strategy.js')

/**
 * All available strategies by name
 * @type {Record<string, new (config: any) => BaseStrategy>}
 */
const STRATEGIES = {
  'settlement-sniper': SettlementSniperStrategy,
  'coinbase-fair-value': CoinbaseFairValueStrategy,
  'momentum-rider': MomentumRiderStrategy,
  'gamma-scalper': GammaScalperStrategy,
  'swing-flipper': SwingFlipperStrategy
}

/**
 * Strategy metadata for UI
 */
const STRATEGY_INFO = {
  'settlement-sniper': {
    name: 'Settlement Sniper',
    description: 'Volatility-adjusted probability model (pseudo Black-Scholes) trading the 2-5 min sweet spot before settlement',
    type: 'crypto',
    recommended: true,
    defaultParams: new SettlementSniperStrategy({}).getDefaultParams()
  },
  'coinbase-fair-value': {
    name: 'Coinbase Fair Value',
    description: 'Calculates fair probability from Coinbase spot vs Kalshi strike, trades divergences',
    type: 'crypto',
    recommended: true,
    defaultParams: new CoinbaseFairValueStrategy({}).getDefaultParams()
  },
  'momentum-rider': {
    name: 'Momentum Rider',
    description: 'Rides Kalshi momentum with Coinbase spot confirmation — buys at 65-80¢ and rides to settlement',
    type: 'crypto',
    recommended: false,
    defaultParams: new MomentumRiderStrategy({}).getDefaultParams()
  },
  'gamma-scalper': {
    name: 'Gamma Scalper',
    description: 'Buys cheap OTM brackets (5-15¢) when spot trends toward the bracket range — targets 10¢ take profit with 5¢ stop loss',
    type: 'crypto',
    recommended: false,
    defaultParams: new GammaScalperStrategy({}).getDefaultParams()
  },
  'swing-flipper': {
    name: 'Swing Flipper',
    description: 'Rides intra-window oscillation on ATM brackets (30-60¢) — buys pullbacks, sells recoveries for 8¢ flips',
    type: 'crypto',
    recommended: false,
    defaultParams: new SwingFlipperStrategy({}).getDefaultParams()
  }
}

/**
 * Create strategy instances from config
 * @param {Record<string, { enabled: boolean, params: Object }>} strategyConfigs
 * @returns {BaseStrategy[]}
 */
const createStrategies = (strategyConfigs) => {
  const strategies = []

  for (const [name, config] of Object.entries(strategyConfigs)) {
    const StrategyClass = STRATEGIES[name]
    if (StrategyClass) {
      strategies.push(new StrategyClass(config))
    }
  }

  return strategies
}

/**
 * Get default config for all strategies
 * @returns {Record<string, { enabled: boolean, params: Object }>}
 */
const getDefaultStrategyConfigs = () => {
  const configs = {}

  for (const [name, StrategyClass] of Object.entries(STRATEGIES)) {
    const instance = new StrategyClass({})
    configs[name] = {
      enabled: false,
      params: instance.getDefaultParams()
    }
  }

  return configs
}

module.exports = {
  STRATEGIES,
  STRATEGY_INFO,
  createStrategies,
  getDefaultStrategyConfigs,
  BaseStrategy,
  CoinbaseFairValueStrategy,
  SettlementSniperStrategy,
  MomentumRiderStrategy,
  GammaScalperStrategy,
  SwingFlipperStrategy
}
