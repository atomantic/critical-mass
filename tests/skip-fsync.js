// @ts-check
/**
 * Preloaded into every test process by scripts/test.js.
 *
 * Every test write lands in the runner's disposable temp root, which is deleted
 * when the run ends, so flushing it to stable storage protects nothing. It is
 * not free: on macOS libuv implements fsync as F_FULLFSYNC (a full drive-cache
 * flush), and the suite issues about 16,400 of them: roughly three quarters of
 * `npm test` wall time on a developer Mac.
 *
 * The replacement still validates the descriptor, so a sync on a closed or
 * invalid fd throws EBADF as before. Tests that pin durability ordering or
 * fsync failure handling replace or spy on fs.fsyncSync themselves, which this
 * preload does not affect. Processes a test spawns without these preloads keep
 * real fsync.
 */
const fs = require('fs');

const { fstatSync } = fs;
fs.fsyncSync = (fd) => {
  fstatSync(fd);
};
