const { describe } = require('node:test');

describe('sentinel ai deadline', () => require('./cases/sentinel-service/sentinel-ai-deadline'));
describe('sentinel alerts ordering', () => require('./cases/sentinel-service/sentinel-alerts-ordering'));
describe('lifecycle', () => require('./cases/sentinel-service/lifecycle'));
