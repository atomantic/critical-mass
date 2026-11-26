const { describe } = require('node:test');

describe('actions', () => require('./cases/updown-signal/actions'));
describe('engine crossover isolation', () => require('./cases/updown-signal/engine-crossover-isolation'));
describe('engine dampener steps', () => require('./cases/updown-signal/engine-dampener-steps'));
describe('engine null indicator scoring', () => require('./cases/updown-signal/engine-null-indicator-scoring'));
describe('engine', () => require('./cases/updown-signal/engine'));
describe('stability', () => require('./cases/updown-signal/stability'));
