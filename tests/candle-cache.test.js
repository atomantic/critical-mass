const { describe } = require('node:test');

describe('derive', () => require('./cases/candle-cache/derive'));
describe('gemini seed', () => require('./cases/candle-cache/gemini-seed'));
describe('seed retry', () => require('./cases/candle-cache/seed-retry'));
describe('volume delta', () => require('./cases/candle-cache/volume-delta'));
