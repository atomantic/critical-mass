// @ts-check
const fs = require('fs');
const path = require('path');

/**
 * Move an unreadable/unrecognized state file aside as `<file>.corrupt-<ts>` so
 * the next persist cannot silently overwrite it. Never throws — this runs on
 * load and timer paths where a failed rename must not crash the process.
 * @param {string} filePath - File to quarantine
 * @param {{warn: Function}} logger - Context logger
 * @returns {string|null} Quarantine path, or null when the rename failed
 */
const quarantineFile = (filePath, logger) => {
  const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(filePath, quarantinePath);
    return quarantinePath;
  } catch (err) {
    logger.warn(`⚠️ Could not quarantine ${path.basename(filePath)}: ${err.message}`, {
      filePath,
      quarantinePath,
      error: err.message,
    });
    return null;
  }
};

/**
 * Guard a gateway-owned JSON state load. A missing or empty file is "no saved
 * state" and is left alone. A file that does not parse, or is not a JSON
 * object, is moved aside as `<file>.corrupt-<ts>` (original bytes preserved)
 * with one error log line, so the caller's empty start cannot overwrite it.
 * Call before reading the file; the shared readJSON then sees it missing.
 * @param {string} filePath - State file
 * @param {{warn: Function, error: Function}} logger - Context logger
 * @returns {string|null} Quarantine path, or null when nothing was quarantined
 */
const quarantineIfUnreadable = (filePath, logger) => {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (!content.trim()) return null;
  let reason;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return null;
    reason = 'not a JSON object';
  } catch (err) {
    reason = err.message;
  }
  const quarantinePath = quarantineFile(filePath, logger);
  logger.error(`❌ ${path.basename(filePath)} is unreadable (${reason}); ${quarantinePath ? `moved aside to ${quarantinePath}` : 'could not be moved aside'} and starting empty`, {
    filePath,
    quarantinePath,
    error: reason,
  });
  return quarantinePath;
};

module.exports = { quarantineFile, quarantineIfUnreadable };
