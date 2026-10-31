// @ts-check
/**
 * Preloaded into every test process by scripts/test.js.
 *
 * Test files run concurrently, and several write fixed names under DATA_DIR or
 * remove it in an after() hook (backup-service.test.js). Give each test-file
 * process its own data root under the runner's disposable one, before
 * src/paths.js resolves DATA_DIR, so files cannot see or delete each other's
 * fixtures. Subprocesses a test spawns inherit the narrowed root.
 */
const fs = require('fs');
const path = require('path');

const runnerDataRoot = process.env.CRITICAL_MASS_DATA_DIR;
// Only test-file processes: the orchestrating parent has no NODE_TEST_CONTEXT.
if (process.env.NODE_TEST_CONTEXT && runnerDataRoot) {
  const ownRoot = path.join(runnerDataRoot, `pid-${process.pid}`);
  fs.mkdirSync(ownRoot, { recursive: true });
  process.env.CRITICAL_MASS_DATA_DIR = ownRoot;
}
