// @ts-check
/**
 * Centralized path constants for data directories.
 * Single source of truth — import from here instead of re-declaring DATA_DIR.
 */

const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const KALSHI_DATA_DIR = path.join(DATA_DIR, 'kalshi');
const HEDGE_DATA_DIR = path.join(DATA_DIR, 'hedge');
const UPDOWN_DATA_DIR = path.join(DATA_DIR, 'updown');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEYS_DIR = path.join(__dirname, '..', 'keys');

module.exports = { DATA_DIR, KALSHI_DATA_DIR, HEDGE_DATA_DIR, UPDOWN_DATA_DIR, BACKUP_DIR, KEYS_DIR };
