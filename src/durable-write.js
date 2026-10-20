// @ts-check
// Leaf owner of durable file publication. Keep project imports limited to fsync-dir.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { fsyncDir } = require('./fsync-dir');

/** Flush existing file bytes without changing its contents or permissions.
 * @param {string} file
 */
const fsyncFile = (file) => {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

/**
 * Publish flushed bytes atomically, then flush the directory entry. A failure
 * after publication can leave the new bytes visible; transaction callers own
 * recovery. Exclusive publication never replaces an existing destination.
 * A serialized transaction may supply a recoverable sibling temporaryPath; it
 * must remove any orphan during recovery before attempting another write.
 * @param {string} file
 * @param {string|Buffer} data
 * @param {{mode?: number, preserveMode?: boolean, exclusive?: boolean, temporaryPath?: string}} [options]
 */
const atomicWriteSync = (file, data, { mode = 0o600, preserveMode = false, exclusive = false, temporaryPath } = {}) => {
  let existingMode;
  if (preserveMode) {
    try { existingMode = fs.statSync(file).mode & 0o777; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const temporary = temporaryPath ?? `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  let ownsTemporary = false;
  try {
    fd = fs.openSync(temporary, 'wx', existingMode ?? mode);
    ownsTemporary = true;
    // Preserve the operator's exact permissions, even under a stricter umask.
    if (preserveMode) fs.fchmodSync(fd, existingMode ?? mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (exclusive) {
      fs.linkSync(temporary, file);
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, file);
    }
    ownsTemporary = false;
    fsyncDir(path.dirname(file));
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (ownsTemporary) { try { fs.rmSync(temporary, { force: true }); } catch {} }
    throw error;
  }
};

module.exports = { fsyncFile, atomicWriteSync };
