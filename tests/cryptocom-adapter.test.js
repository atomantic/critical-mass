const { describe } = require('node:test');

describe('mapping', () => require('./cases/cryptocom-adapter/mapping'));
describe('orders', () => require('./cases/cryptocom-adapter/orders'));
describe('cryptocom auth', () => require('./cases/cryptocom-adapter/cryptocom-auth'));
describe('cryptocom order status', () => require('./cases/cryptocom-adapter/cryptocom-order-status'));
