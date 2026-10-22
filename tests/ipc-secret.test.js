const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createIPCServer } = require('../src/ipc/ipc-server');
const { createIPCClient } = require('../src/ipc/ipc-client');
const { getIpcSecret, ipcSecretMatches, resetIpcSecretCache, IPC_SECRET_HEADER } = require('../src/ipc/ipc-secret');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return false;
};

describe('IPC shared secret (#1580)', () => {
  const cleanup = [];
  afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

  const startServer = async (secret) => {
    const port = await freePort();
    const server = createIPCServer(port, 'test-engine', { secret });
    server.onRequest('ping:test', async () => ({ ok: true }));
    await server.start();
    cleanup.push(() => server.stop());
    return port;
  };
  const connectClient = (port, secret) => {
    const client = createIPCClient(`ws://127.0.0.1:${port}`, 'test', { secret, reconnectMin: 50, reconnectMax: 100 });
    client.connect();
    cleanup.push(() => client.disconnect());
    return client;
  };

  it('accepts a client presenting the correct secret', async () => {
    const port = await startServer('s3cret');
    const client = connectClient(port, 's3cret');
    assert.ok(await waitFor(() => client.isConnected()));
    assert.deepEqual(await client.request('ping:test', {}), { ok: true });
  });

  it('refuses a client with a wrong secret', async () => {
    const port = await startServer('s3cret');
    const client = connectClient(port, 'wrong');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(client.isConnected(), false);
  });

  it('refuses a raw connection with no secret header', async () => {
    const port = await startServer('s3cret');
    const status = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      });
      sock.once('data', (d) => { resolve(String(d).split('\r\n')[0]); sock.destroy(); });
    });
    assert.match(status, /401/);
    assert.equal(IPC_SECRET_HEADER, 'x-critical-mass-ipc-secret');
  });

  it('ipcSecretMatches is strict about type, length and emptiness', () => {
    assert.equal(ipcSecretMatches('abc', 'abc'), true);
    assert.equal(ipcSecretMatches('abc', 'abcd'), false);
    assert.equal(ipcSecretMatches(undefined, 'abc'), false);
    assert.equal(ipcSecretMatches(['abc'], 'abc'), false);
    assert.equal(ipcSecretMatches('', ''), false);
  });

  it('creates a 0600 secret file once and reuses it; env overrides', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-secret-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    resetIpcSecretCache();
    const first = getIpcSecret({ env: {}, dataDir: dir });
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(path.join(dir, 'ipc-secret')).mode & 0o777, 0o600);
    resetIpcSecretCache();
    assert.equal(getIpcSecret({ env: {}, dataDir: dir }), first);
    assert.equal(getIpcSecret({ env: { CRITICAL_MASS_IPC_SECRET: ' override ' }, dataDir: dir }), 'override');
    assert.deepEqual(fs.readdirSync(dir), ['ipc-secret']);
  });
});
