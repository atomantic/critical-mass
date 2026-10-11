'use strict';
// Run the real gateway in an external, credential-free application copy. Only
// synthetic engine handlers and public-market seeding are substituted.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { syntheticFills } = require('./perf-fixture');
const ROOT = path.resolve(__dirname, '../..');
const FUNDS = [['coinbase', 'BTC-USDC'], ['coinbase', 'ETH-USDC'], ['gemini', 'BTCUSD'], ['cryptocom', 'CRO_USD']];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
};
const childEnv = () => Object.fromEntries(['PATH', 'SystemRoot', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
async function stopChild(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await done;
  clearTimeout(timer);
}
async function startBrowserFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-browser-perf-'));
  const engines = [];
  let gateway;
  let feed;
  const stop = async () => {
    clearInterval(feed);
    await stopChild(gateway);
    await Promise.all(engines.map(engine => engine.stop()));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    for (const file of ['server.js', 'package.json', 'ecosystem.config.cjs', 'config.example.json', 'src', 'shared']) {
      fs.cpSync(path.join(ROOT, file), path.join(dir, file), { recursive: true });
    }
    fs.mkdirSync(path.join(dir, 'admin'));
    for (const file of ['src', 'public', 'index.html', 'package.json', 'vite.config.js', 'tailwind.config.js', 'postcss.config.js']) {
      if (fs.existsSync(path.join(ROOT, 'admin', file))) fs.cpSync(path.join(ROOT, 'admin', file), path.join(dir, 'admin', file), { recursive: true });
    }
    for (const part of ['', 'admin']) fs.symlinkSync(fs.realpathSync(path.join(ROOT, part, 'node_modules')), path.join(dir, part, 'node_modules'), 'dir');
    // Fixture-only introspection; production bundles never expose this handle.
    fs.appendFileSync(path.join(dir, 'admin/src/main.jsx'), '\nimport { getSocket } from "./hooks/useTradeEvents"; window.__perfSocket = getSocket;\n');
    const build = spawn(process.execPath, [path.join(dir, 'admin/node_modules/vite/bin/vite.js'), 'build'], { cwd: path.join(dir, 'admin'), env: childEnv(), stdio: 'ignore' });
    if ((await once(build, 'exit'))[0] !== 0) throw new Error('fixture UI build failed');
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.example.json')));
    config.exchanges = {};
    for (const [exchange, pair] of FUNDS) {
      config.exchanges[exchange] ||= { pairs: {} };
      config.exchanges[exchange].pairs[pair] = { productId: pair, enabled: false, dryRun: true, dcaStrategy: 'regime', totalAllocation: 10000, regime: { enabled: false, depositedCapital: 10000 } };
    }
    config.global = { simpleDcaEnabled: false, backup: { enabled: false }, sentinel: { enabled: false } };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
    fs.mkdirSync(path.join(dir, 'data'));
    const ledger = syntheticFills(30000).map(fill => ({ ...fill, rawExchangeResponse: 'synthetic-detail-only'.repeat(10) }));
    fs.writeFileSync(path.join(dir, 'data/fill-ledger.json'), JSON.stringify(ledger));
    require(path.join(dir, 'src/logger')).createContextLogger = () => ({ info() {}, warn() {}, error() {} });
    const { createIPCServer } = require(path.join(dir, 'src/ipc/ipc-server'));
    const { createTransactionsReadView } = require(path.join(dir, 'src/transactions-regime-query'));
    const { createSocketIOProxy } = require(path.join(dir, 'src/ipc/socket-io-proxy'));
    const env = childEnv();
    for (const exchange of ['coinbase', 'gemini', 'cryptocom']) {
      const port = await freePort();
      env[`${exchange.toUpperCase()}_IPC_PORT`] = String(port);
      const engine = createIPCServer(port, `perf-${exchange}`);
      engines.push(engine);
      const view = createTransactionsReadView(() => ledger, () => 'synthetic-1');
      engine.onRequest('regime:fills', query => query.paged ? view.query(query) : ({ fills: ledger }));
      engine.onRequest('regime:status', () => ({ success: true, status: { running: false, isDryRun: true, market: { lastPrice: 50000 }, health: { mode: 'STOPPED' }, position: {} } }));
      engine.onRequest('regime:open-orders', () => ({ success: true, orders: [] }));
      engine.onRequest('regime:manual-trades', () => ({ success: true, trades: [] }));
      await engine.start();
      engine.perfProxy = createSocketIOProxy(engine);
    }
    // Seeding public candles and starting prediction workers are outside this
    // scenario. Block outbound HTTP as well, so new startup work fails closed.
    fs.writeFileSync(path.join(dir, 'perf-preload.cjs'), `
      const cache = require('./src/candle-cache');
      const original = cache.createCandleCache;
      cache.createCandleCache = (...args) => ({ ...original(...args), seedAll: async () => {} });
      const updown = require('./src/updown/updown-service');
      const create = updown.createUpDownService;
      updown.createUpDownService = (...args) => ({ ...create(...args), start: async () => {} });
      global.fetch = async () => { throw new Error('fixture outbound fetch disabled'); };
      for (const name of ['http', 'https']) {
        const transport = require(name);
        for (const method of ['request', 'get']) {
          const original = transport[method];
          transport[method] = (options, ...args) => {
            const host = options?.hostname || options?.host;
            const ports = ['COINBASE_IPC_PORT', 'GEMINI_IPC_PORT', 'CRYPTOCOM_IPC_PORT'].map(key => process.env[key]);
            if (host !== '127.0.0.1' || !ports.includes(String(options.port))) throw new Error('fixture outbound HTTP disabled');
            return original(options, ...args);
          };
        }
      }
    `);
    const port = await freePort();
    gateway = spawn(process.execPath, ['--require', './perf-preload.cjs', 'server.js'], {
      cwd: dir, env: { ...env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore',
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 200; i++) {
      if (gateway.exitCode !== null) throw new Error('isolated gateway exited');
      try { ready = (await fetch(`${baseUrl}/api/auth/session`)).ok; } catch { /* still starting */ }
      if (ready) break;
      await pause(50);
    }
    if (!ready) throw new Error('isolated gateway startup timed out');
    // Enroll only in the disposable fixture. The browser subsequently uses the
    // ordinary sign-in form, rather than a bearer or authentication bypass.
    const password = require('node:crypto').randomBytes(24).toString('hex');
    const enrolled = await fetch(`${baseUrl}/api/auth/password`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    if (!enrolled.ok) throw new Error('fixture enrollment failed');
    let sequence = 0;
    feed = setInterval(() => {
      sequence++;
      for (const [index, [exchange, pair]] of FUNDS.entries()) engines[['coinbase', 'gemini', 'cryptocom'].indexOf(exchange)].perfProxy.emit('regime:status', {
        exchange, pair, status: { running: false, isDryRun: true, market: { lastPrice: 61000 + index * 1000 + sequence }, health: { mode: 'STOPPED' }, position: {} },
      });
    }, 1000);
    return { dir, baseUrl, password, stop, funds: FUNDS }; 
  } catch (error) {
    await stop();
    throw error;
  }
}
module.exports = { startBrowserFixture, stopChild, freePort, FUNDS };
