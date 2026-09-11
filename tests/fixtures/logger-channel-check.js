// Fixture for tests/logger.test.js's child-process channel-routing check.
// Runs in a real, unmocked node process so the assertions verify actual
// OS-level stdout/stderr file descriptors (the ones PM2 splits into
// out/error log files), not an in-process console.* stub.
const { log, createContextLogger } = require('../../src/logger');

log('INFO', 'fixture info message');
log('WARN', 'fixture warn message');
log('ERROR', 'fixture error message');

const logger = createContextLogger({ fixture: true });
logger.info('fixture contextual info');
logger.warn('fixture contextual warn');
logger.error('fixture contextual error');
