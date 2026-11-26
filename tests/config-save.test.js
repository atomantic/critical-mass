const { describe } = require('node:test');

describe('config base drift', () => require('./cases/config-save/config-base-drift'));
describe('error', () => require('./cases/config-save/error'));
describe('payload', () => require('./cases/config-save/payload'));
describe('config settings import order', () => require('./cases/config-save/config-settings-import-order'));
describe('currency suffixes', () => require('./cases/config-save/currency-suffixes'));
describe('depth capability persistence', () => require('./cases/config-save/depth-capability-persistence'));
