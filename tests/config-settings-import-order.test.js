// @ts-check
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Fresh processes catch partial CommonJS initialization that a warm require cache
// hides. Exercise both existing back-edges and direct domain-module imports.
it('keeps facade, validator and snapshot contracts intact in either import order (#1719)', () => {
  const orders = [
    ['config-utils', 'config-validator', 'config-snapshot'],
    ['config-validator', 'config-snapshot', 'config-utils'],
    ['config-snapshot', 'config-validator', 'config-utils'],
    ['config-settings/notification', 'config-settings/aggressiveness', 'config-settings/backup', 'config-settings/sentinel', 'config-validator', 'config-snapshot'],
  ];
  for (const order of orders) {
    const output = execFileSync(process.execPath, ['--trace-warnings', '-e', `
      const assert = require('node:assert/strict');
      const warnings = [];
      process.on('warning', warning => warnings.push(warning.message));
      for (const name of JSON.parse(process.argv[1])) require('./src/' + name);
      const facade = require('./src/config-utils');
      const validator = require('./src/config-validator');
      const snapshot = require('./src/config-snapshot');
      assert.equal(facade.NOTIFICATION_DEFAULTS, require('./src/config-settings/notification').NOTIFICATION_DEFAULTS);
      assert.equal(facade.BACKUP_INTERVAL_BOUNDS, require('./src/config-settings/backup').BACKUP_INTERVAL_BOUNDS);
      assert.equal(facade.SENTINEL_DEFAULTS, require('./src/config-settings/sentinel').SENTINEL_DEFAULTS);
      assert.equal(facade.SENTINEL_POLL_INTERVAL_BOUNDS, require('./src/config-settings/sentinel').SENTINEL_POLL_INTERVAL_BOUNDS);
      assert.equal(facade.SENTINEL_MAX_ALERTS_BOUNDS, require('./src/config-settings/sentinel').SENTINEL_MAX_ALERTS_BOUNDS);
      for (const name of ['getNotificationConfig', 'updateNotificationConfig', 'getAggressivenessPresets', 'updateAggressivenessPresets', 'getBackupConfig', 'updateBackupConfig', 'getSentinelConfig', 'updateSentinelConfig']) {
        assert.equal(typeof facade[name], 'function', name);
      }
      assert.deepEqual(facade.validateRegimeConfig(facade.DEFAULT_AGGRESSIVENESS_PRESETS.moderate), validator.validateRegimeConfig(facade.DEFAULT_AGGRESSIVENESS_PRESETS.moderate));
      const config = { exchanges: {}, global: {} };
      assert.deepEqual(facade.buildConfigSnapshot(config), snapshot.buildConfigSnapshot(config));
      assert.equal(facade.CONFIG_SNAPSHOT_VERSION, snapshot.CONFIG_SNAPSHOT_VERSION);
      setImmediate(() => assert.deepEqual(warnings, []));
    `, JSON.stringify(order)], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(output, '', order.join(' -> '));
  }
});
