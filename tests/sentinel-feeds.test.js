const { describe } = require('node:test');

describe('sentinel feed health', () => require('./cases/sentinel-feeds/sentinel-feed-health'));
describe('sentinel feed parity', () => require('./cases/sentinel-feeds/sentinel-feed-parity'));
describe('sentinel feed xml', () => require('./cases/sentinel-feeds/sentinel-feed-xml'));
