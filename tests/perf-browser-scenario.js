'use strict';
// Actual protected shell navigation; no browser-local network mocks.
const { aggregate } = require('../scripts/lib/perf-metrics');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(browser, expression) {
  for (let i = 0; i < 300; i++) {
    if (await browser.evaluate(expression)) return;
    await pause(50);
  }
  throw new Error('browser content did not become useful before the deadline');
}
const state = `(() => {
  const socket = window.__perfSocket();
  return { connected: socket.connected, id: socket.id,
    statusListeners: socket.listeners('regime:status').length,
    connectListeners: socket.listeners('connect').length,
    tradeListeners: socket.listeners('trade:event').length };
})()`;
const rowCount = `document.querySelector('nav[aria-label="Transactions pagination"]')?.parentElement.querySelectorAll('tbody tr').length`;
async function runBrowserScenario({ browser, fixture, metrics, idleMs = 60000 }) {
  const checks = [];
  const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });
  const route = '/coinbase/BTC-USDC/transactions';
  await browser.call('Page.navigate', { url: fixture.baseUrl + route });
  await waitFor(browser, `!!document.querySelector('#operator-password')`);
  await browser.evaluate(`(() => {
    const input = document.querySelector('#operator-password');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(fixture.password)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await browser.evaluate(`document.querySelector('#operator-password').form.requestSubmit()`);
  await waitFor(browser, `${rowCount} === 100`);
  await browser.call('Page.navigate', { url: 'about:blank' });
  await browser.call('Network.clearBrowserCache');
  await browser.call('Network.setCacheDisabled', { cacheDisabled: true });
  metrics.phase = 'transactions';
  const coldStart = performance.now();
  await browser.call('Page.navigate', { url: fixture.baseUrl + route });
  await waitFor(browser, `${rowCount} === 100 && window.__perfSocket().connected`);
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const timeToUsefulMs = Math.round(performance.now() - coldStart);
  check('bounded rendered Transactions rows', await browser.evaluate(rowCount) === 100);
  await pause(10500); // a real polling tick, with the production 10-second cadence
  await metrics.flush();
  const transactions = aggregate(metrics.collector, metrics.phase, performance.now() - coldStart);
  const txState = await browser.evaluate(state);
  const configs = metrics.collector.http.filter(row => row.phase === 'transactions' && /\/config\?/.test(row.endpoint));
  check('stable Transactions config read is not polled', configs.length === 1);
  check('page response cap and compact projection', metrics.pages.length >= 2 && metrics.pages.every(page => page.rows === 100 && page.total === 30000 && page.compact && page.bytes < 300 * 1024));
  check('no eager details requests', !metrics.collector.http.some(row => row.phase === 'transactions' && /details/.test(row.endpoint)));
  check('Transactions receives real IPC websocket telemetry', Object.keys(transactions.ws).some(event => event === 'in regime:status'));

  metrics.phase = 'config-load';
  const configStart = performance.now();
  await browser.evaluate(`document.querySelector('a[href="/coinbase/BTC-USDC/config"]').click()`);
  await waitFor(browser, `location.pathname.endsWith('/config') && !!document.querySelector('main input')`);
  await pause(500); // settle navigation reads before starting the idle window
  await metrics.flush();
  const configLoad = aggregate(metrics.collector, metrics.phase, performance.now() - configStart);
  const configState = await browser.evaluate(state);
  metrics.phase = 'config-idle';
  const idleStart = performance.now();
  await pause(idleMs);
  await metrics.flush();
  const config = aggregate(metrics.collector, metrics.phase, performance.now() - idleStart);
  check('Config does not hydrate historical fills', ![...Object.keys(configLoad.http), ...Object.keys(config.http)].some(key => /\/fills/.test(key)));
  check('unmounted Transactions leaves no fills/open-orders polling', !Object.keys(config.http).some(key => /fills|open-orders|manual-trades/.test(key)));
  check('stable Config reference reads are not repeatedly transferred', !Object.keys(config.http).some(key => /\/config(?:\?|$)/.test(key)));
  check('Transactions unmount preserves only shell websocket consumers', configState.statusListeners === txState.statusListeners && configState.tradeListeners === txState.tradeListeners);
  // The shell intentionally keeps one status consumer and one toast consumer.
  // A dashboard adds one fund consumer; Overview adds one all-fund consumer.
  metrics.phase = 'validation';
  check('gateway enforces the page cap on oversized requests', await browser.evaluate(`fetch('/api/coinbase/regime/fills?pair=BTC-USDC&paged=true&pageSize=99999').then(r => r.json()).then(data => data.fills?.length === 100)`));
  const edited = await browser.evaluate(`fetch('/api/coinbase/config?pair=BTC-USDC', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ totalAllocation: 12345 }) }).then(r => r.ok)`);
  await browser.evaluate(`document.querySelector('a[href="/coinbase/BTC-USDC/transactions"]').click()`);
  await waitFor(browser, `${rowCount} === 100`);
  await metrics.flush();
  check('remount invalidates stable config after a change', edited && metrics.changedConfigRead);
  metrics.phase = 'reconnect';
  const visiblePrices = `(() => {
    const prices = document.querySelector('main').textContent.match(/(?:61|62|63|64),[0-9]{3}(?:\\.[0-9]{2})?/g) || [];
    return Object.fromEntries(prices.map(price => [price.slice(0, 2), price]));
  })()`;
  const reconnect = async prefixes => {
    await waitFor(browser, `${JSON.stringify(prefixes)}.every(prefix => (${visiblePrices})[prefix])`);
    const beforePrices = await browser.evaluate(visiblePrices);
    const before = await browser.evaluate(state);
    await browser.evaluate('void window.__perfSocket().reconnect()');
    await waitFor(browser, `window.__perfSocket().connected && window.__perfSocket().id !== ${JSON.stringify(before.id)}`);
    // Existing DOM values cannot establish recovery: require a newer live
    // fixture tick for each visible fund after the new transport connects.
    await waitFor(browser, `${JSON.stringify(prefixes)}.every(prefix => (${visiblePrices})[prefix] && (${visiblePrices})[prefix] !== ${JSON.stringify(beforePrices)}[prefix])`);
    const after = await browser.evaluate(state);
    return ['statusListeners', 'connectListeners', 'tradeListeners'].every(key => before[key] === after[key]);
  };
  await browser.evaluate(`document.querySelector('a[href="/coinbase/BTC-USDC"]').click()`);
  await waitFor(browser, `(window.__perfSocket?.().listeners('regime:status').length || 0) === ${configState.statusListeners + 1}`);
  check('fund-specific consumer reconnect restores exactly its listeners', await reconnect(['61']));
  check('fund consumer filters sibling telemetry after reconnect', await browser.evaluate("!document.querySelector('main').textContent.includes('62,')"));
  await browser.evaluate(`document.querySelector('a[href="/"]').click()`);
  await waitFor(browser, `location.pathname === '/' && (window.__perfSocket?.().listeners('regime:status').length || 0) === ${configState.statusListeners + 1}`);
  check('Overview all-fund consumer reconnect restores exactly its listeners', await reconnect(['61', '62', '63', '64']));
  await browser.evaluate(`document.querySelector('a[href="/coinbase/BTC-USDC"]').click()`);
  await waitFor(browser, `location.pathname === '/coinbase/BTC-USDC' && !!document.querySelector('a[href="/coinbase/BTC-USDC/config"]')`);
  await browser.evaluate(`document.querySelector('a[href="/coinbase/BTC-USDC/config"]').click()`);
  await waitFor(browser, `location.pathname.endsWith('/config') && window.__perfSocket().listeners('regime:status').length === ${configState.statusListeners}`);
  check('Overview unmount removes its all-fund consumer', true);
  await pause(500);
  await metrics.flush();
  check('completed HTTP reads succeeded', metrics.collector.http.every(row => row.status >= 200 && row.status < 400));
  check('no browser runtime exceptions', metrics.runtimeErrors === 0);
  return { timeToUsefulMs, transactions, configLoad, config, checks, failedReads: metrics.collector.http.filter(row => row.status >= 400).map(row => ({ endpoint: row.endpoint, status: row.status, phase: row.phase })) };
}
module.exports = { runBrowserScenario, waitFor };
