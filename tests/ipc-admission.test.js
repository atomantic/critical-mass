// @ts-check
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createIPCClient } = require('../src/ipc/ipc-client');
const { IPC_CHANNELS: C, IPC_REQUEST_LIMITS, ipcRequestLane, engineBusy, MSG_TYPE, createMessage } = require('../src/ipc/ipc-protocol');
const { getPendingWrites } = require('../src/pending-writes');
const { ipcFailureResponse } = require('../src/routes/route-utils');
const { startEngineIpc, until, deferred, trackTimers, restoreTimers, installFakeWebSocket, FakeWebSocket, commands } = require('./helpers/ipc-command-harness');

const cleanups = [];
afterEach(async () => {
  restoreTimers();
  while (cleanups.length) await cleanups.pop()();
});
const connect = async (url) => {
  const client = createIPCClient(url, 'admission');
  cleanups.push(() => client.disconnect());
  client.connect();
  await until(() => client.isConnected(), 'IPC connection');
  return client;
};
const engine = async (register) => {
  const ipc = await startEngineIpc(register);
  cleanups.push(() => ipc.server.stop());
  return { ...ipc, client: await connect(ipc.url) };
};
const busy = (result) => {
  assert.deepEqual(result, engineBusy());
  assert.equal(ipcFailureResponse(result).status, 503);
};

describe('bounded IPC admission', () => {
  it('caps a 400-preview deferred-exchange burst and reserves control capacity', async () => {
    const config = require('../src/config-utils');
    mock.method(config, 'updateRegimeConfig', () => {});
    const { createRegimeEngine } = require('../src/regime-engine');
    const { registerRegimeIpcHandlers } = require('../src/ipc/regime-ipc-handlers');
    const { fundKey } = require('../src/shared-utils');
    const fund = createRegimeEngine('gemini', 'BTC-USD', { dryRun: true, productId: 'BTC-USD' }, {});
    fund._getConfig().entryMode = 'ladder';
    fund._getConfig().maxUsdcDeployed = 1000;
    fund._test.setRunning(true);
    const hold = deferred();
    let active = 0;
    let peak = 0;
    let calls = 0;
    fund._test.setAdapter({ getAccountBalance: async () => {
      calls++;
      peak = Math.max(peak, ++active);
      try { await hold.promise; return { available: '1000' }; }
      finally { active--; }
    } });
    cleanups.push(() => { fund._test.setRunning(false); fund._test.clearTimers(); });
    cleanups.push(() => hold.resolve());
    const { client, url } = await engine((server) => {
      registerRegimeIpcHandlers(server, {
        regimeEngines: new Map([[fundKey('gemini', 'BTC-USD'), fund]]),
        resolvePair: () => 'BTC-USD', fundKey,
      });
      for (const channel of [C.REGIME_STATUS, C.REGIME_STOP, C.REGIME_STOP_ALL, C.ENGINE_MAINTENANCE, C.ENGINE_BACKUP_PAUSE, C.ENGINE_BACKUP_RESUME]) {
        server.onRequest(channel, async () => ({ success: true }));
      }
      server.onRequest('config_update', async () => { throw new Error('must not run'); });
    });
    const burst = Array.from({ length: 400 }, () => client.request(C.REGIME_PREVIEW_LADDER, {}, 'gemini', 'BTC-USD'));
    // These are immediate local refusals, even though the admitted previews wait.
    for (const result of await Promise.all(burst.slice(32))) busy(result);
    await until(() => calls === 32, '32 real preview balance reads');
    assert.equal(getPendingWrites().filter((w) => w.label === `ipc:${C.REGIME_PREVIEW_LADDER}`).length, 32);
    for (const channel of [C.REGIME_STATUS, C.REGIME_STOP, C.REGIME_STOP_ALL, C.ENGINE_MAINTENANCE, C.ENGINE_BACKUP_PAUSE, C.ENGINE_BACKUP_RESUME]) {
      assert.deepEqual(await client.request(channel, {}), { success: true });
    }
    // A different connection bypasses the client bound but not engine admission.
    const other = await connect(url);
    busy(await other.request(C.REGIME_PREVIEW_LADDER, {}, 'gemini', 'BTC-USD'));
    busy(await other.sendConfigUpdate({}));
    assert.equal(calls, 32);
    hold.resolve();
    await Promise.all(burst);
    assert.equal(active, 0);
    assert.equal(peak, 32);
    await client.request(C.REGIME_PREVIEW_LADDER, {}, 'gemini', 'BTC-USD');
    assert.equal(calls, 33, 'settlement restores capacity');
  });

  it('bounds control work across clients, releases synchronous throws and leaves ordinary work usable', async () => {
    const hold = deferred();
    cleanups.push(() => hold.resolve());
    let calls = 0;
    const { client, url } = await engine((server) => {
      server.onRequest(C.REGIME_STATUS, async () => { calls++; await hold.promise; return { success: true }; });
      server.onRequest(C.REGIME_STOP, () => { throw new Error('stop threw'); });
      server.onRequest('test:ordinary', () => { throw new Error('ordinary threw'); });
    });
    const pending = Array.from({ length: 4 }, () => client.request(C.REGIME_STATUS, {}));
    await until(() => calls === 4, 'four control handlers');
    busy(await client.request(C.REGIME_STOP, {}));
    const other = await connect(url);
    busy(await other.request(C.REGIME_STATUS, {}));
    await assert.rejects(client.request('test:ordinary', {}), /ordinary threw/);
    hold.resolve();
    await Promise.all(pending);
    for (let i = 0; i < 8; i++) await assert.rejects(client.request(C.REGIME_STOP, {}), /stop threw/);
    assert.deepEqual(await client.request(C.REGIME_STATUS, {}), { success: true });
  });

  it('retains engine capacity through caller timeout, disconnect and shutdown until handlers settle', async () => {
    const hold = deferred();
    cleanups.push(() => hold.resolve());
    let calls = 0;
    const { client, server, url } = await engine((ipc) => {
      ipc.onRequest('test:held', async () => { calls++; await hold.promise; return { success: true }; });
    });
    const requests = Array.from({ length: 32 }, () => client.request('test:held', {}, undefined, 100));
    const rejected = Promise.all(requests.map((request) => assert.rejects(request, /timeout/)));
    await until(() => calls === 32, 'admitted requests');
    await rejected;
    busy(await client.request('test:held', {}));
    client.disconnect();
    const other = await connect(url);
    busy(await other.request('test:held', {}));
    server.setShuttingDown(true);
    assert.equal((await other.request('test:held', {})).code, 'engine-shutting-down');
    assert.equal((await other.sendConfigUpdate({})).code, 'engine-shutting-down');
    server.setShuttingDown(false);
    busy(await other.request('test:held', {}));
    hold.resolve();
    await until(() => !getPendingWrites().some((w) => w.label === 'ipc:test:held'), 'engine settlement');
    assert.deepEqual(await other.request('test:held', {}), { success: true });
    assert.equal(calls, 33);
  });

  it('applies server capacity and settlement ownership to legacy config-update frames', async () => {
    const hold = deferred();
    cleanups.push(() => hold.resolve());
    let calls = 0;
    const { client, url } = await engine((server) => {
      server.onRequest('config_update', async () => { calls++; await hold.promise; throw new Error('config threw'); });
      server.onRequest('test:ordinary', async () => ({ success: true }));
    });
    const updates = Array.from({ length: 32 }, () => client.sendConfigUpdate({}));
    await until(() => calls === 32, 'config handlers');
    const other = await connect(url);
    busy(await other.request('test:ordinary', {}));
    // Legacy one-way senders cannot bypass server admission either.
    const socket = new WebSocket(url, { headers: { 'x-critical-mass-ipc-secret': require('../src/ipc/ipc-protocol').getIpcSecret() } });
    cleanups.push(() => socket.close());
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    const response = new Promise((resolve) => socket.addEventListener('message', (event) => resolve(JSON.parse(event.data).payload), { once: true }));
    socket.send(JSON.stringify(createMessage(MSG_TYPE.CONFIG_UPDATE, 'ignored-channel', {})));
    busy(await response);
    assert.equal(calls, 32);
    client.disconnect();
    await Promise.all(updates);
    busy(await other.request('test:ordinary', {}));
    hold.resolve();
    await until(() => !getPendingWrites().some((w) => w.label === 'ipc:config_update'), 'config settlement');
    assert.deepEqual(await other.request('test:ordinary', {}), { success: true });
  });

  it('bounds client timers and config updates, then restores both lanes after replies and send failures', async () => {
    const { live } = trackTimers();
    cleanups.push(installFakeWebSocket());
    const client = createIPCClient('ws://127.0.0.1:1', 'fake');
    cleanups.push(() => client.disconnect());
    client.connect();
    const sock = FakeWebSocket.instances[0];
    sock.open();
    const updates = Array.from({ length: 32 }, () => client.sendConfigUpdate({}));
    const controls = Array.from({ length: 4 }, () => client.request(C.REGIME_STATUS, {}));
    busy(await client.sendConfigUpdate({}));
    busy(await client.request('test:ordinary', {}));
    busy(await client.request(C.REGIME_STOP, {}));
    assert.equal(live.size, 36);
    assert.equal(commands(sock).length, 36);
    for (const frame of commands(sock)) sock.receive(JSON.stringify(createMessage(MSG_TYPE.RESPONSE, frame.channel, { success: true }, { id: frame.id })));
    await Promise.all([...updates, ...controls]);
    assert.equal(live.size, 0);
    mock.method(sock, 'send', () => { throw new Error('send threw'); });
    await assert.rejects(client.request('test:ordinary', {}), /send threw/);
    assert.equal(live.size, 0, 'failed send must release the deadline and pending slot');
  });

  it('defaults new channels and config updates to ordinary capacity', () => {
    assert.deepEqual(IPC_REQUEST_LIMITS, { ordinary: 32, control: 4 });
    for (const channel of [C.REGIME_STATUS, C.REGIME_STOP, C.REGIME_STOP_ALL, C.ENGINE_MAINTENANCE, C.ENGINE_BACKUP_PAUSE, C.ENGINE_BACKUP_RESUME]) assert.equal(ipcRequestLane(channel), 'control');
    for (const channel of ['new:channel', 'config_update', C.REGIME_PREVIEW_LADDER, C.REGIME_START, C.REGIME_FILLS]) assert.equal(ipcRequestLane(channel), 'ordinary');
  });
});
