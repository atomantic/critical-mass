const { describe } = require('node:test');

describe('dry run celestial structured logging', () => require('./cases/dry-run-accounting/dry-run-celestial-structured-logging'));
describe('dry run pnl history', () => require('./cases/dry-run-accounting/dry-run-pnl-history'));
describe('fee defaults', () => require('./cases/dry-run-accounting/fee-defaults'));
describe('regime dry run fills', () => require('./cases/dry-run-accounting/regime-dry-run-fills'));
