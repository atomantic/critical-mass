const { describe } = require('node:test');

describe('core', () => require('./cases/gateway-listen/core'));
describe('gateway security headers', () => require('./cases/gateway-listen/gateway-security-headers'));
