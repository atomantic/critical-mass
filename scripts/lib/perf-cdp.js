'use strict';
// Minimal Chrome DevTools driver; uses the existing ws dependency, never
// downloads a browser or reads an operator's browser profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');
const { stopChild } = require('./perf-browser-fixture');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function startChrome(executable = process.env.CM_PERF_CHROME) {
  executable ||= ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(file => fs.existsSync(file));
  if (!executable || !fs.existsSync(executable)) throw new Error('Chrome unavailable; set CM_PERF_CHROME to an installed executable');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-perf-chrome-'));
  let child;
  let socket;
  const pending = new Map();
  const stop = async () => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('Chrome stopped')); }
    pending.clear();
    socket?.close();
    await stopChild(child);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank'], { stdio: 'ignore', env: Object.fromEntries(['PATH', 'SystemRoot', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]])) });
    child.on('error', () => {});
    let port;
    for (let i = 0; i < 200; i++) {
      if (fs.existsSync(path.join(dir, 'DevToolsActivePort'))) { port = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; }
      if (child.exitCode !== null) throw new Error('Chrome exited before DevTools startup');
      await pause(50);
    }
    if (!port) throw new Error('Chrome DevTools startup timed out');
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, 'open');
    const listeners = new Map();
    let id = 0;
    socket.on('message', bytes => {
      const msg = JSON.parse(bytes.toString());
      if (msg.id) {
        const request = pending.get(msg.id);
        if (!request) return;
        pending.delete(msg.id);
        clearTimeout(request.timer);
        msg.error ? request.reject(new Error(msg.error.message)) : request.resolve(msg.result);
      } else for (const handler of listeners.get(msg.method) || []) handler(msg.params);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`DevTools ${method} timed out`)); }, 15000);
      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    let evaluation = 0;
    const evaluate = async expression => {
      const current = ++evaluation;
      const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).catch(error => { throw new Error('browser evaluation ' + current + ': ' + error.message); });
      if (result.exceptionDetails) throw new Error('browser scenario expression failed');
      return result.result.value;
    };
    await call('Runtime.enable');
    await call('Network.enable');
    await call('Page.enable');
    return { call, evaluate, on: (event, handler) => listeners.set(event, [...(listeners.get(event) || []), handler]), stop };
  } catch (error) { await stop(); throw error; }
}
module.exports = { startChrome };
