const path = require('node:path');

// Resolve relative to the application, not the shell's or PM2 daemon's cwd.
const ENV_FILE = path.resolve(__dirname, '..', '.env');

function loadRuntimeEnv() {
  try {
    // Node preserves values already supplied by the shell or container runtime.
    process.loadEnvFile(ENV_FILE);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    // Do not include the original error/cause: it may contain sensitive values.
    throw new Error('Unable to load the repository-root .env file. Check that it is a readable file and restart.');
  }
}

module.exports = { loadRuntimeEnv };
