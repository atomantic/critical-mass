const { describe } = require('node:test');

describe('context logger', () => require('./cases/backtest-engine/context-logger'));
describe('backtest fee leakage', () => require('./cases/backtest-engine/backtest-fee-leakage'));
describe('backtest price cache durability', () => require('./cases/backtest-engine/backtest-price-cache-durability'));
describe('backtest same interval funding', () => require('./cases/backtest-engine/backtest-same-interval-funding'));
