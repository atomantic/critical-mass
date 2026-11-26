const { describe } = require('node:test');

describe('analysis parity', () => require('./cases/scorecard/analysis-parity'));
describe('backfill publication', () => require('./cases/scorecard/backfill-publication'));
describe('by hour prediction bucket', () => require('./cases/scorecard/by-hour-prediction-bucket'));
describe('contract expiry', () => require('./cases/scorecard/contract-expiry'));
describe('hydration idempotence', () => require('./cases/scorecard/hydration-idempotence'));
describe('indicators config', () => require('./cases/scorecard/indicators-config'));
describe('journal health', () => require('./cases/scorecard/journal-health'));
describe('recovery lag limit', () => require('./cases/scorecard/recovery-lag-limit'));
describe('restart backfill', () => require('./cases/scorecard/restart-backfill'));
describe('tally history', () => require('./cases/scorecard/tally-history'));
describe('up only', () => require('./cases/scorecard/up-only'));
