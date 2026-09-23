// @ts-check
/**
 * Centralized path constants for data directories.
 * Single source of truth — import from here instead of re-declaring DATA_DIR.
 */

const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(APP_ROOT, 'data');
const UPDOWN_DATA_DIR = path.join(DATA_DIR, 'updown');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEYS_DIR = path.join(APP_ROOT, 'keys');

module.exports = { APP_ROOT, DATA_DIR, UPDOWN_DATA_DIR, BACKUP_DIR, KEYS_DIR };
