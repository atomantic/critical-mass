// @ts-check
/**
 * Backup Service
 *
 * Handles scheduled and manual backups of trading data files.
 * Uses spawnSync for zip/unzip operations.
 * Excludes API keys and backup directory from archives.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

/**
 * Ensure backups directory exists
 */
const ensureBackupsDir = () => {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
};

/**
 * Create a backup of all data files
 * @param {Object} options
 * @param {boolean} [options.includePriceCache=false] - Include price cache files (~45MB per exchange)
 * @returns {{ success: boolean, filename?: string, sizeBytes?: number, error?: string }}
 */
const createBackup = ({ includePriceCache = false } = {}) => {
  ensureBackupsDir();

  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
  const filename = `backup-${timestamp}.zip`;
  const zipPath = path.join(BACKUPS_DIR, filename);

  // Build exclusion patterns
  const excludes = [
    'backups/*',        // Don't include backups dir in backup
    '*-keys.json',      // Never include API keys
    '*/*-keys.json',    // Keys in subdirectories
  ];

  if (!includePriceCache) {
    excludes.push('*-price-cache*.json');
    excludes.push('*/*-price-cache*.json');
  }

  const excludeArgs = excludes.flatMap(pattern => ['-x', pattern]);

  // Create zip from data directory
  const result = spawnSync('zip', [
    '-r',               // Recursive
    '-q',               // Quiet
    zipPath,
    '.',                // Current directory (data/)
    ...excludeArgs,
  ], {
    cwd: DATA_DIR,
    timeout: 60000,     // 60 second timeout
  });

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString().trim() : 'Unknown zip error';
    return { success: false, error: stderr };
  }

  const stats = fs.statSync(zipPath);
  return { success: true, filename, sizeBytes: stats.size };
};

/**
 * List all backups sorted newest-first
 * @returns {Array<{ filename: string, createdAt: string, sizeBytes: number }>}
 */
const listBackups = () => {
  ensureBackupsDir();

  const files = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith('backup-') && f.endsWith('.zip'));

  return files
    .map(filename => {
      const filePath = path.join(BACKUPS_DIR, filename);
      const stats = fs.statSync(filePath);
      return {
        filename,
        createdAt: stats.mtime.toISOString(),
        sizeBytes: stats.size,
      };
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
};

/**
 * Delete a single backup
 * @param {string} filename - Backup filename to delete
 * @returns {{ success: boolean, error?: string }}
 */
const deleteBackup = (filename) => {
  // Path traversal protection
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return { success: false, error: 'Invalid filename' };
  }

  if (!filename.startsWith('backup-') || !filename.endsWith('.zip')) {
    return { success: false, error: 'Invalid backup filename format' };
  }

  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return { success: false, error: 'Backup not found' };
  }

  fs.unlinkSync(filePath);
  return { success: true };
};

/**
 * Prune old backups to keep only maxBackups
 * @param {number} maxBackups - Maximum number of backups to keep
 * @returns {{ pruned: number, remaining: number }}
 */
const pruneBackups = (maxBackups) => {
  const backups = listBackups(); // sorted newest-first
  let pruned = 0;

  if (backups.length > maxBackups) {
    const toDelete = backups.slice(maxBackups);
    for (const backup of toDelete) {
      const result = deleteBackup(backup.filename);
      if (result.success) pruned++;
    }
  }

  return { pruned, remaining: backups.length - pruned };
};

/**
 * Restore a backup by extracting files to data directory
 * Skips keys files and backups directory during restore
 * @param {string} filename - Backup filename to restore
 * @returns {{ success: boolean, filesRestored?: number, error?: string }}
 */
const restoreBackup = (filename) => {
  // Path traversal protection
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return { success: false, error: 'Invalid filename' };
  }

  if (!filename.startsWith('backup-') || !filename.endsWith('.zip')) {
    return { success: false, error: 'Invalid backup filename format' };
  }

  const zipPath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(zipPath)) {
    return { success: false, error: 'Backup not found' };
  }

  // Create temp directory for extraction
  const tempDir = path.join(DATA_DIR, `.restore-temp-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  // Extract to temp directory
  const extractResult = spawnSync('unzip', [
    '-o',               // Overwrite without prompting
    '-q',               // Quiet
    zipPath,
    '-d', tempDir,
  ], {
    timeout: 60000,
  });

  if (extractResult.status !== 0) {
    // Clean up temp dir
    spawnSync('rm', ['-rf', tempDir]);
    const stderr = extractResult.stderr ? extractResult.stderr.toString().trim() : 'Unknown unzip error';
    return { success: false, error: stderr };
  }

  // Copy files from temp to data, skipping keys and backups
  let filesRestored = 0;
  const copyFiles = (srcDir, destDir, relativePath = '') => {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);
      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      // Skip backups directory and keys files
      if (entry.name === 'backups') continue;
      if (entry.name.endsWith('-keys.json')) continue;

      if (entry.isDirectory()) {
        if (!fs.existsSync(destPath)) {
          fs.mkdirSync(destPath, { recursive: true });
        }
        copyFiles(srcPath, destPath, relPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
        filesRestored++;
      }
    }
  };

  copyFiles(tempDir, DATA_DIR);

  // Clean up temp directory
  spawnSync('rm', ['-rf', tempDir]);

  return { success: true, filesRestored };
};

module.exports = {
  createBackup,
  listBackups,
  deleteBackup,
  pruneBackups,
  restoreBackup,
};
