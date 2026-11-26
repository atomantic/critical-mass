const { describe } = require('node:test');

describe('regime position state identity', () => require('./cases/regime-state-store/regime-position-state-identity'));
describe('regime state legacy renames', () => require('./cases/regime-state-store/regime-state-legacy-renames'));
describe('regime state persistence', () => require('./cases/regime-state-store/regime-state-persistence'));
describe('regime state readonly cache', () => require('./cases/regime-state-store/regime-state-readonly-cache'));
