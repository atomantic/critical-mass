const { describe } = require('node:test');

describe('ai endpoint grants', () => require('./cases/updown-routes/ai-endpoint-grants'));
describe('error envelope issue 1329', () => require('./cases/updown-routes/error-envelope-issue-1329'));
