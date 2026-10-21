// @ts-check
//
// The repair scripts refuse to write a fund's ledger/state while its engine is
// live. Getting that check wrong is how a repair silently evaporates: the engine
// holds both files in memory and rewrites them on its own timer.
//
// The check this replaces used the mtime of `regime-engine-running.json` with a
// 5-minute staleness window, which was wrong twice over — the file is written
// once at start and once at stop (engine-lifecycle-handlers.js:119,190), so its
// mtime is the START time and any engine up longer than the window read as
// "stopped"; and an ABSENT file read as "stopped" too, which is the state of
// every fund whose directory was recreated — exactly when a repair runs.
//
// Disk safety: sentinel pair '__testliveness__' per tests/no-live-fund-in-tests.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');

const { checkEngineStopped, checkGatewayStopped, claimGatewayListeners, readRunningFlag, isPortListening } = require('../src/engine-liveness');
const { resolveFundDataDir } = require('../src/migration');

const TEST_PAIR = '__testliveness__';
// An exchange with no known IPC port, so checkEngineStopped has only the flag
// to go on — that is the branch these cases exercise.
const UNPROBEABLE = '__testexchange__';
const JUNK_DIR = path.join(require('../src/paths').DATA_DIR, 'coinbase', TEST_PAIR);
const UNPROBEABLE_DIR = path.join(require('../src/paths').DATA_DIR, UNPROBEABLE);
const FLAG = path.join(JUNK_DIR, 'regime-engine-running.json');

after(() => {
  fs.rmSync(JUNK_DIR, { recursive: true, force: true });
  fs.rmSync(UNPROBEABLE_DIR, { recursive: true, force: true });
});

const writeFlag = (value) => {
  fs.mkdirSync(JUNK_DIR, { recursive: true });
  fs.writeFileSync(FLAG, JSON.stringify(value));
};

/** Write the flag where checkEngineStopped will look for THIS exchange. */
const writeFlagFor = (exchange, value) => {
  const dir = resolveFundDataDir(exchange, TEST_PAIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'regime-engine-running.json'), JSON.stringify(value));
};

describe('readRunningFlag', () => {
  it('reports the recorded state, and null when absent or unreadable', () => {
    fs.rmSync(JUNK_DIR, { recursive: true, force: true });
    assert.equal(readRunningFlag('coinbase', TEST_PAIR), null, 'absent file is unknown, not "stopped"');

    writeFlag({ running: true, startedAt: new Date().toISOString() });
    assert.equal(readRunningFlag('coinbase', TEST_PAIR), true);

    writeFlag({ running: false });
    assert.equal(readRunningFlag('coinbase', TEST_PAIR), false);

    fs.writeFileSync(FLAG, '{ not json');
    assert.equal(readRunningFlag('coinbase', TEST_PAIR), null, 'corrupt file is unknown, not "stopped"');

    writeFlag({ startedAt: 'no running key' });
    assert.equal(readRunningFlag('coinbase', TEST_PAIR), null);
  });
});

describe('isPortListening', () => {
  it('detects a listening socket and reports a closed port as free', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (server.address()).port;

    assert.equal(await isPortListening(port), true, 'an open port is detected');

    await new Promise((resolve) => server.close(resolve));
    assert.equal(await isPortListening(port), false, 'a closed port is free');
  });
});

describe('checkEngineStopped', () => {
  it('refuses when the flag records the engine as running, without probing', async () => {
    writeFlag({ running: true, startedAt: '2020-01-01T00:00:00.000Z' });
    const result = await checkEngineStopped('coinbase', TEST_PAIR);
    assert.equal(result.safe, false);
    assert.match(result.reason, /RUNNING/);
    // The old check would have passed this: the flag is years stale.
  });

  it('refuses an unknown exchange with no flag rather than assuming stopped', async () => {
    fs.rmSync(UNPROBEABLE_DIR, { recursive: true, force: true });
    const result = await checkEngineStopped(UNPROBEABLE, TEST_PAIR);
    assert.equal(result.safe, false, 'unknown liveness must fail closed');
  });

  it('trusts an explicit stopped flag on an exchange it cannot probe', async () => {
    writeFlagFor(UNPROBEABLE, { running: false });
    const result = await checkEngineStopped(UNPROBEABLE, TEST_PAIR);
    assert.equal(result.safe, true);
  });
});

describe('checkGatewayStopped', () => {
  it('refuses while the gateway port accepts loopback connections, under the deployed HOST forms', async () => {
    const saved = { PORT: process.env.PORT, HOST: process.env.HOST };
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (server.address()).port;
    try {
      process.env.PORT = String(port);
      for (const host of [undefined, '0.0.0.0', '127.0.0.1']) {
        if (host === undefined) delete process.env.HOST; else process.env.HOST = host;
        const result = await checkGatewayStopped({ defaultPort: port });
        assert.equal(result.safe, false, `HOST=${host ?? '(unset)'} must detect the gateway`);
        assert.match(result.reason, new RegExp(`127\\.0\\.0\\.1:${port}`));
      }
      // A stray shell PORT must not hide a gateway on the PM2 port.
      process.env.PORT = '1';
      assert.equal((await checkGatewayStopped({ defaultPort: port })).safe, false, 'the PM2 port is always probed');
      await new Promise((resolve) => server.close(resolve));
      process.env.PORT = String(port);
      assert.equal((await checkGatewayStopped({ defaultPort: port })).safe, true, 'a closed gateway port is safe');
    } finally {
      if (server.listening) server.close();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});

describe('claimGatewayListeners', () => {
  it('holds the gateway address so a starting gateway or a second CLI write cannot bind it, until released', async () => {
    const saved = process.env.PORT;
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (probe.address()).port;
    await new Promise((resolve) => probe.close(resolve));
    try {
      process.env.PORT = String(port);
      const claim = await claimGatewayListeners({ defaultPort: port, hosts: ['127.0.0.1'] });
      assert.equal(claim.claimed, true);

      const gateway = net.createServer();
      const bindError = await new Promise((resolve) => {
        gateway.once('error', resolve);
        gateway.listen(port, '127.0.0.1', () => resolve(null));
      });
      assert.equal(/** @type {any} */ (bindError)?.code, 'EADDRINUSE', 'a gateway starting mid-command fails its bind');

      const second = await claimGatewayListeners({ defaultPort: port, hosts: ['127.0.0.1'] });
      assert.equal(second.claimed, false);
      assert.match(/** @type {{reason: string}} */ (second).reason, /holds 127\.0\.0\.1:/);

      await /** @type {{release: () => Promise<void>}} */ (claim).release();
      const again = await claimGatewayListeners({ defaultPort: port, hosts: ['127.0.0.1'] });
      assert.equal(again.claimed, true, 'release frees the address');
      await /** @type {{release: () => Promise<void>}} */ (again).release();
    } finally {
      if (saved === undefined) delete process.env.PORT; else process.env.PORT = saved;
    }
  });
});
