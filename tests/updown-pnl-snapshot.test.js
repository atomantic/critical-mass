// @ts-check
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const script = path.join(__dirname, '..', 'scripts', 'updown-pnl-snapshot.js');
const roots = [];
const servers = [];

/** Listen on an ephemeral loopback port and return it. */
const listen = () => new Promise((resolve) => {
  const server = net.createServer();
  servers.push(server);
  server.listen(0, '127.0.0.1', () => resolve(/** @type {net.AddressInfo} */ (server.address()).port));
});

/** A port nothing listens on: bind an ephemeral one, then release it. */
const freePort = async () => {
  const port = await listen();
  await new Promise((resolve) => servers.pop().close(resolve));
  return port;
};

/**
 * Isolated data root whose paths and gateway port the child sees through a
 * preload, so the run never reads live data or probes a real gateway.
 */
const fixture = (gatewayPort) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'updown-pnl-snapshot-'));
  roots.push(root);
  const state = {
    signalHistory: [],
    perpBook: { lots: [], realizedPnl: 12.5, closedTrades: [{ pnl: 12.5 }], contractSizeBtc: 0.01 },
  };
  const statePath = path.join(root, 'updown-state.json');
  fs.writeFileSync(statePath, JSON.stringify(state));
  const preload = path.join(root, 'preload.js');
  const paths = path.join(__dirname, '..', 'src', 'paths.js');
  const ecosystem = path.join(__dirname, '..', 'ecosystem.config.cjs');
  fs.writeFileSync(preload, [
    `const paths = require(${JSON.stringify(paths)});`,
    `paths.DATA_DIR = ${JSON.stringify(root)};`,
    `paths.UPDOWN_DATA_DIR = ${JSON.stringify(path.join(root, 'updown'))};`,
    `require(${JSON.stringify(ecosystem)}).PORTS.API = ${gatewayPort};`,
  ].join('\n'));
  return { root, statePath, preload, original: fs.readFileSync(statePath, 'utf8') };
};

// Async spawn: the gateway stand-in listens in this process and must keep
// accepting connections while the child probes it.
const run = (preload, gatewayPort, ...args) => new Promise((resolve) => {
  const env = { ...process.env, PORT: String(gatewayPort) };
  delete env.HOST;
  const child = spawn(process.execPath, ['--require', preload, script, ...args], { env });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (status) => resolve({ status, stderr }));
});

const backups = (root) => fs.readdirSync(root).filter(name => name.startsWith('updown-state.json.backup-'));

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('updown-pnl-snapshot book rewrites', () => {
  it('refuses to reset the book while the gateway is listening', async () => {
    const port = await listen();
    const { root, statePath, preload, original } = fixture(port);

    const result = await run(preload, port, '--reset-book');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to rewrite the book: the gateway is accepting connections/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), original);
    assert.deepEqual(backups(root), []);
  });

  it('backs up the previous book before resetting it', async () => {
    const port = await freePort();
    const { root, statePath, preload, original } = fixture(port);

    const result = await run(preload, port, '--reset-book');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).perpBook.realizedPnl, 0);
    const [backup] = backups(root);
    assert.ok(backup, 'a backup must be written');
    assert.equal(fs.readFileSync(path.join(root, backup), 'utf8'), original);
  });
});
