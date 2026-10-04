#!/usr/bin/env node
'use strict';
// Route-load and idle-network audit (issue #935). See docs/perf-route-audit.md.
//
//   node scripts/perf-route-audit.js                 # isolated synthetic fixture (default)
//   CM_PERF_TOKEN=... node scripts/perf-route-audit.js --base-url http://127.0.0.1:5570
//
// Replays the Transactions -> Config navigation at the HTTP/websocket protocol
// level using the same request shapes and cadence as the admin UI, then
// aggregates per redacted endpoint/event. Exit codes: 0 PASS, 1 FAIL, 2 UNVERIFIED.

const path = require('node:path');
const { createCollector, aggregate, requested, verdict } = require('./lib/perf-metrics');
const { startFixture, EXCHANGES } = require('./lib/perf-fixture');

const { io } = require(require.resolve('socket.io-client', { paths: [path.join(__dirname, '..', 'admin'), __dirname] }));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PAGE_CAP = 100;
const MAX_PAGE_BYTES = 300 * 1024;

function createClient(baseUrl, token, collector) {
  let phase = 'init';
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  async function get(pathAndQuery) {
    const start = collector.now();
    const res = await fetch(baseUrl + pathAndQuery, { headers });
    const text = await res.text();
    const wire = Number(res.headers.get('content-length'));
    collector.recordHttp({
      method: 'GET', url: pathAndQuery, start, end: collector.now(), status: res.status,
      wireBytes: Number.isFinite(wire) && res.headers.get('content-encoding') ? wire : (res.headers.get('content-encoding') ? null : Buffer.byteLength(text)),
      decodedBytes: Buffer.byteLength(text), phase,
    });
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON body is only counted */ }
    return { status: res.status, body };
  }
  return { get, setPhase: p => { phase = p; }, get phase() { return phase; }, headers };
}

function connectSocket(baseUrl, token, collector, client) {
  const socket = io(baseUrl, { auth: token ? { token } : {}, reconnection: true, reconnectionDelay: 50, transports: ['websocket'] });
  socket.onAny((event, ...args) => collector.recordWs({
    event, at: collector.now(), bytes: Buffer.byteLength(JSON.stringify(args)), phase: client.phase,
  }));
  return socket;
}

const connected = socket => new Promise(resolve => (socket.connected ? resolve() : socket.once('connect', resolve)));

async function runAudit({ baseUrl, token, pollMs = 10000, idleMs = 60000, exchange = 'coinbase', roomsOf }) {
  const collector = createCollector();
  const client = createClient(baseUrl, token, collector);
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });

  // Fund-specific consumer (Transactions view): its own exchange room only.
  const socket = connectSocket(baseUrl, token, collector, client);
  let subscribed = new Set();
  const sync = wanted => {
    for (const ex of wanted) if (!subscribed.has(ex)) socket.emit(`${ex}:subscribe`);
    for (const ex of subscribed) if (!wanted.includes(ex)) socket.emit(`${ex}:unsubscribe`);
    subscribed = new Set(wanted);
  };
  socket.on('connect', () => { for (const ex of subscribed) socket.emit(`${ex}:subscribe`); });
  await connected(socket);

  // Phase 1: cold Transactions route + at least one polling tick.
  client.setPhase('transactions');
  sync([exchange]);
  const t0 = collector.now();
  const pagedQuery = '/regime/fills?paged=true&page=0&pageSize=100&side=all&cycle=all&sortField=timestamp&sortDir=desc';
  const [, first] = await Promise.all([
    client.get(`/api/${exchange}/config`),
    client.get(`/api/${exchange}${pagedQuery}`),
    client.get(`/api/${exchange}/regime/status`),
    client.get(`/api/${exchange}/regime/open-orders`),
  ]);
  const timeToUsefulMs = Math.round(collector.now() - t0);
  const poll = setInterval(() => {
    client.get(`/api/${exchange}${pagedQuery}`).catch(() => {});
    client.get(`/api/${exchange}/regime/status`).catch(() => {});
    client.get(`/api/${exchange}/regime/open-orders`).catch(() => {});
  }, pollMs);
  await sleep(pollMs + 300);
  clearInterval(poll); // unmount: Transactions leaves the route
  sync([]);
  await sleep(100);
  const tx = aggregate(collector, 'transactions', collector.now() - t0);

  // Phase 2: Config route (no historical fills) then an idle window.
  client.setPhase('config');
  const c0 = collector.now();
  await client.get(`/api/${exchange}/config`);
  await sleep(idleMs);
  const cfg = aggregate(collector, 'config', collector.now() - c0);

  // Phase 3: reconnect restores exactly the visible consumers' subscriptions.
  client.setPhase('reconnect');
  const reconnectRooms = async (label, wanted) => {
    sync(wanted);
    await sleep(100);
    socket.io.engine.close();
    await sleep(50);
    await connected(socket);
    await sleep(150);
    if (roomsOf) check(`reconnect restores ${label} subscriptions`, JSON.stringify(roomsOf(socket.id)) === JSON.stringify([...wanted].sort()), `expected ${wanted.join(',')}`);
    return wanted;
  };
  if (roomsOf) {
    await reconnectRooms('fund-specific', [exchange]);
    await reconnectRooms('Overview all-fund', [...EXCHANGES]);
  }
  sync([]);
  socket.close();

  const rows = first.body?.fills?.length ?? -1;
  check('cold Transactions returns a bounded page', first.status === 200 && rows >= 0 && rows <= PAGE_CAP, `rows=${rows}`);
  check('page response bytes bounded', Object.entries(tx.http).filter(([k]) => /regime\/fills/.test(k)).every(([, v]) => v.maxDecodedBytes <= MAX_PAGE_BYTES));
  check('no overlapping requests per endpoint', [...Object.values(tx.http), ...Object.values(cfg.http)].every(v => v.maxOverlap <= 1));
  check('Config does not hydrate fill history', !requested(cfg, /regime\/fills/));
  check('Config stable read is not repeated while idle', (cfg.http['GET /api/:exchange/config']?.count ?? 0) === 1);
  check('no polling left by unmounted Transactions', Object.keys(cfg.http).every(k => /\/config$/.test(k)));
  check('no websocket traffic after consumer unmount', Object.values(cfg.ws).every(w => w.count === 0) || Object.keys(cfg.ws).length === 0);
  return { timeToUsefulMs, transactions: tx, config: cfg, checks };
}

function render(result) {
  const lines = [`time to useful content: ${result.timeToUsefulMs} ms`];
  for (const s of [result.transactions, result.config]) {
    lines.push(`\n[${s.phase}] window ${Math.round(s.windowMs)} ms, ${s.totalBytesPerMinute} B/min total`);
    for (const [k, v] of Object.entries(s.http)) lines.push(`  http ${k}: n=${v.count} wire=${v.wireBytes ?? 'n/a'} decoded=${v.decodedBytes} overlap=${v.maxOverlap}`);
    for (const [k, v] of Object.entries(s.ws)) lines.push(`  ws   ${k}: n=${v.count} bytes=${v.bytes} (${v.bytesPerMinute} B/min)`);
  }
  lines.push('');
  for (const c of result.checks) lines.push(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = { fixture: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base-url') { out.baseUrl = argv[++i]; out.fixture = false; }
    else if (argv[i] === '--idle-seconds') out.idleMs = Number(argv[++i]) * 1000;
    else if (argv[i] === '--poll-seconds') out.pollMs = Number(argv[++i]) * 1000;
    else if (argv[i] === '--exchange') out.exchange = argv[++i];
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const finish = (state, result, reasons) => {
    if (args.json) console.log(JSON.stringify({ verdict: state, reasons, ...result }, null, 2));
    else { if (result) console.log(render(result)); console.log(`\nVERDICT: ${state}${reasons.length ? ` - ${reasons.join('; ')}` : ''}`); }
    return state === 'PASS' ? 0 : state === 'FAIL' ? 1 : 2;
  };
  if (!args.fixture && !process.env.CM_PERF_TOKEN) {
    return finish('UNVERIFIED', null, ['no authorized session: set CM_PERF_TOKEN (operator password bearer) for --base-url runs']);
  }
  let fixture = null;
  try {
    if (args.fixture) fixture = await startFixture();
    const result = await runAudit({
      baseUrl: fixture ? fixture.baseUrl : args.baseUrl,
      token: fixture ? null : process.env.CM_PERF_TOKEN,
      pollMs: args.pollMs, idleMs: args.idleMs, exchange: args.exchange,
      roomsOf: fixture ? fixture.roomsOf : undefined,
    });
    const reasons = ['protocol-level replay: browser rendering and real engine transport are not exercised'];
    if (!fixture) reasons.push('reconnect subscription sets not inspectable on an external gateway');
    return finish(verdict(result.checks, fixture ? [] : reasons.slice(1)), result, fixture ? [] : reasons.slice(1));
  } catch (err) {
    return finish('UNVERIFIED', null, [`audit could not run: ${err.message}`]);
  } finally {
    if (fixture) await fixture.stop();
  }
}

if (require.main === module) main().then(code => process.exit(code));

module.exports = { runAudit, main, parseArgs, PAGE_CAP };
