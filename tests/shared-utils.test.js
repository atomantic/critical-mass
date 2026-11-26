const { describe } = require('node:test');

describe('core utility structured logging', () => require('./cases/shared-utils/core-utility-structured-logging'));
describe('cancelled status', () => require('./cases/shared-utils/cancelled-status'));
describe('finite float', () => require('./cases/shared-utils/finite-float'));
describe('floor', () => require('./cases/shared-utils/floor'));
describe('is filled status', () => require('./cases/shared-utils/is-filled-status'));
describe('json diagnostics', () => require('./cases/shared-utils/json-diagnostics'));
describe('order still open', () => require('./cases/shared-utils/order-still-open'));
describe('read boolean flag', () => require('./cases/shared-utils/read-boolean-flag'));
