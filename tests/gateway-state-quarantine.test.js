const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { quarantineIfUnreadable } = require('../src/state-tracker');
const { createUpDownService } = require('../src/updown/updown-service');
const { createSentinelService } = require('../src/sentinel/sentinel-service');
const { createOperatorAuth } = require('../src/operator-auth');
const { readJSON, writeJSON } = require('../src/shared-utils');

const dirs = [];
const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-quarantine-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const corruptFiles = (dir, base) => fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.corrupt-`));
const BAD = '{"contract": {"expiry": 12';
const io = { to: () => ({ emit: () => {} }), emit: () => {} };

const makeLogger = () => {
  const calls = { warn: [], error: [] };
  return { calls, warn: (m) => calls.warn.push(m), error: (m) => calls.error.push(m) };
};

describe('quarantineIfUnreadable', () => {
  it('returns null silently for a missing or empty file', () => {
    const dir = tmpDir();
    const logger = makeLogger();
    const file = path.join(dir, 's.json');
    assert.equal(quarantineIfUnreadable(file, logger), null);
    fs.writeFileSync(file, '  \n');
    assert.equal(quarantineIfUnreadable(file, logger), null);
    assert.deepEqual(logger.calls, { warn: [], error: [] });
    assert.deepEqual(corruptFiles(dir, 's.json'), []);
  });

  it('leaves a valid object alone and quarantines unparseable or wrong-shape files', () => {
    const dir = tmpDir();
    const logger = makeLogger();
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, '{"a":1}');
    assert.equal(quarantineIfUnreadable(file, logger), null);
    assert.equal(fs.existsSync(file), true);

    for (const bytes of [BAD, '[1,2]', 'null']) {
      fs.writeFileSync(file, bytes);
      const quarantined = quarantineIfUnreadable(file, logger);
      assert.equal(fs.existsSync(file), false);
      const [moved] = corruptFiles(dir, 's.json');
      assert.equal(quarantined, path.join(dir, moved));
      assert.equal(fs.readFileSync(path.join(dir, moved), 'utf8'), bytes);
      fs.rmSync(path.join(dir, moved));
    }
    assert.equal(logger.calls.error.length, 3);
    assert.match(logger.calls.error[0], /s\.json.*corrupt-/);
  });
});

describe('UpDown and Sentinel loadState', () => {
  it('UpDown quarantines a corrupt state file before any write and starts empty', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'updown-state.json');
    fs.writeFileSync(file, BAD);
    const writes = [];
    createUpDownService(io, { readJSON, writeJSON: (f) => writes.push(f), DATA_DIR: dir, candleCache: {} });
    assert.equal(fs.existsSync(file), false);
    const [moved] = corruptFiles(dir, 'updown-state.json');
    assert.equal(fs.readFileSync(path.join(dir, moved), 'utf8'), BAD);
    assert.deepEqual(writes, []);
  });

  it('UpDown with a missing file starts empty without quarantine', () => {
    const dir = tmpDir();
    createUpDownService(io, { readJSON, writeJSON, DATA_DIR: dir, candleCache: {} });
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('Sentinel quarantines a corrupt state file and starts empty', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'sentinel-state.json');
    fs.writeFileSync(file, BAD);
    const service = createSentinelService(io, {
      readJSON, writeJSON, DATA_DIR: dir, getSentinelConfig: () => ({ enabled: false, feeds: [] }),
    });
    assert.equal(fs.existsSync(file), false);
    const [moved] = corruptFiles(dir, 'sentinel-state.json');
    assert.equal(fs.readFileSync(path.join(dir, moved), 'utf8'), BAD);
    assert.equal(service.getAlerts().length, 0);
  });

  it('Sentinel with a missing file starts empty without quarantine', () => {
    const dir = tmpDir();
    createSentinelService(io, {
      readJSON, writeJSON, DATA_DIR: dir, getSentinelConfig: () => ({ enabled: false, feeds: [] }),
    });
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

describe('operator auth with an unreadable auth file', () => {
  it('treats empty and unrecognized auth records as unreadable, not as unset', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'operator-auth.json');
    for (const bytes of ['', '{}', '[]']) {
      fs.writeFileSync(file, bytes);
      const auth = createOperatorAuth({ authFile: file, readJSON, writeJSON, bootstrapSecret: 'x'.repeat(40) });
      assert.equal(auth.isBootstrapping(), false, JSON.stringify(bytes));
      assert.equal(auth.hasRemoteBootstrap(), false);
    }
    fs.writeFileSync(file, '{"state":"bootstrap"}');
    assert.equal(createOperatorAuth({ authFile: file, readJSON, writeJSON }).isBootstrapping(), true);
    fs.rmSync(file);
    assert.equal(createOperatorAuth({ authFile: file, readJSON, writeJSON }).isBootstrapping(), true);
  });

  it('fails closed: no bootstrap, no enrollment, actionable error, file untouched', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'operator-auth.json');
    fs.writeFileSync(file, BAD);
    const auth = createOperatorAuth({ authFile: file, readJSON, writeJSON, bootstrapSecret: 'x'.repeat(40) });
    assert.equal(auth.isBootstrapping(), false);
    assert.equal(auth.hasPassword(), false);
    assert.equal(auth.hasRemoteBootstrap(), false);

    const app = express();
    app.use(express.json());
    auth.registerSessionRoutes(app);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const session = await fetch(`${base}/api/auth/session`).then((r) => r.json());
      assert.equal(session.authenticated, false);
      assert.equal(session.bootstrapRequired, false);
      assert.equal(session.authFileUnreadable, true);

      const enroll = await fetch(`${base}/api/auth/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'a-new-password-1' }),
      });
      assert.equal(enroll.status, 503);
      assert.match((await enroll.json()).error, /move data\/operator-auth\.json aside/);

      const login = await fetch(`${base}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'a-new-password-1' }),
      });
      assert.equal(login.status, 503);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(fs.readFileSync(file, 'utf8'), BAD);
  });
});
