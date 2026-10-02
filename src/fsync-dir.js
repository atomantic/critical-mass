// @ts-check
const fs = require('fs');

/**
 * Flush directory metadata after creating or renaming entries. Some platforms
 * do not support opening or syncing directories; callers may also preserve a
 * best-effort contract that suppresses every directory-sync error.
 * @param {string} dir - Directory to flush
 * @param {{ignoreAllErrors?: boolean}} [options]
 * @returns {void}
 */
const fsyncDir = (dir, { ignoreAllErrors = false } = {}) => {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    if (!ignoreAllErrors && err.code !== 'EINVAL' && err.code !== 'EPERM') throw err;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (err) {
        if (!ignoreAllErrors && err.code !== 'EINVAL' && err.code !== 'EPERM') throw err;
      }
    }
  }
};

module.exports = { fsyncDir };
