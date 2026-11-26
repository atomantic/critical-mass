const { describe } = require('node:test');

describe('insufficient data', () => require('./cases/updown-indicators/insufficient-data'));
describe('obv slope', () => require('./cases/updown-indicators/obv-slope'));
