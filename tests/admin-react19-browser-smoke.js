'use strict';
// Explicit browser smoke: node tests/admin-react19-browser-smoke.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { startChrome } = require('../scripts/lib/perf-cdp');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-react19-smoke-'));
  let browser, server;
  const errors = [];
  try {
    const admin = path.resolve(__dirname, '../admin');
    const requireAdmin = createRequire(path.join(admin, 'package.json'));
    const { build } = await import(pathToFileURL(requireAdmin.resolve('vite')).href);
    const { default: react } = await import(pathToFileURL(requireAdmin.resolve('@vitejs/plugin-react')).href);
    // Vite 8 uses rolldownOptions; the legacy rollupOptions alias is deprecated.
    await build({ root: admin, configFile: false, plugins: [react()], logLevel: 'silent',
      build: { outDir: dir, rolldownOptions: { input: path.join(admin, 'tests/react19-smoke.html') } } });
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture');
      const file = path.resolve(dir, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end(); return;
      }
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    browser = await startChrome();
    browser.on('Runtime.exceptionThrown', () => errors.push('uncaught browser exception'));
    browser.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') errors.push('browser console error'); });
    await browser.call('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/tests/react19-smoke.html' });
    const waitFor = async expression => {
      for (let i = 0; i < 300; i++) {
        assert.deepEqual(errors, []);
        if (await browser.evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Rendering assertion timed out: ' + expression);
    };
    // A mount alone cannot prove a Three renderer works: require actual draw calls.
    await waitFor('window.__smokeDraws > 5 && !!document.querySelector(\'canvas[aria-label^="Celestial system:"]\')');
    await waitFor('document.querySelectorAll("#layers rect[stroke]").length === 4');
    const geometry = () => browser.evaluate(`(() => {
      const host = document.querySelector('#layers');
      return {
        xs: [...host.querySelectorAll('rect[stroke]')].map(el => Number(el.getAttribute('x'))),
        cloudCount: host.querySelectorAll('polygon[stroke-width="0"]').length,
        markers: [...host.querySelectorAll('text[font-weight="bold"]')].map(el => el.textContent),
        invalid: /NaN|Infinity/.test(host.innerHTML),
      };
    })()`);
    const initial = await geometry();
    assert.equal(initial.cloudCount, 2);
    assert.deepEqual(initial.markers, ['OPEN', 'ADD', 'CLOSE']);
    assert.ok(initial.xs.every((x, i) => Number.isFinite(x) && (!i || x > initial.xs[i - 1])), 'repeated time labels must occupy distinct coordinates');
    assert.equal(initial.invalid, false);
    // Exercise the actual BTCPriceChart + hook, not only standalone layers.
    await waitFor('document.querySelectorAll("#btc rect[stroke]").length > 2 && document.querySelectorAll("#btc polygon").length > 0 && [...document.querySelectorAll("#btc text")].some(el => el.textContent === "OPEN")');
    await browser.evaluate('document.querySelector("#resize").click()');
    await waitFor('document.querySelector("#layers svg").getBoundingClientRect().width === 420');
    const resized = await geometry();
    assert.ok(resized.xs.at(-1) < initial.xs.at(-1), 'overlay geometry must follow responsive width');
    assert.equal(resized.invalid, false);
    await browser.evaluate('document.querySelector("#empty").click()');
    await waitFor('document.querySelectorAll("#layers rect[stroke], #layers polygon").length === 0');
    await browser.evaluate('window.__smokeUnmount()');
    assert.equal(await browser.evaluate('document.querySelectorAll("canvas, svg").length'), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: React 19 StrictMode, repeated-label overlays, responsive resize, actual BTC chart, all Celestial tiers/WebGL draws, empty data and unmount.');
  } finally {
    const results = await Promise.allSettled([browser?.stop(), server && new Promise(resolve => server.close(resolve))]);
    fs.rmSync(dir, { recursive: true, force: true });
    if (results.some(result => result.status === 'rejected')) throw new Error('Smoke fixture cleanup failed');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
