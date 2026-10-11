// @ts-check
// Regression coverage for issue #690: engine IPC port fallbacks drifted from
// ecosystem.config.cjs's PORTS ("single source of truth"), so a dev-mode
// gateway/engine started without *_IPC_PORT env vars resolved the gateway's
// own port (5570) or the Vite dev server's port (5571) instead of an actual
// engine IPC port. This exercises the pure `resolveIpcPort` helper directly —
// no server or engine process is started, and no port is bound.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { resolveIpcPort, IPC_PORT_ENV_VAR, IPC_PORT_DEFAULT } = require('../src/ipc-port-defaults');
const { PORTS } = require('../ecosystem.config.cjs');

describe('resolveIpcPort', () => {
  it('with IPC env vars unset, resolves each exchange to its ecosystem.config.cjs default', () => {
    const env = {};
    assert.equal(resolveIpcPort('coinbase', env), PORTS.COINBASE_IPC);
    assert.equal(resolveIpcPort('gemini', env), PORTS.GEMINI_IPC);
    assert.equal(resolveIpcPort('cryptocom', env), PORTS.CRYPTOCOM_IPC);
  });

  it('never resolves to the gateway API port or the Vite UI port', () => {
    const env = {};
    for (const exchange of ['coinbase', 'gemini', 'cryptocom']) {
      const port = resolveIpcPort(exchange, env);
      assert.notEqual(port, PORTS.API, `${exchange} IPC port must not collide with the gateway (${PORTS.API})`);
      assert.notEqual(port, PORTS.UI, `${exchange} IPC port must not collide with the Vite dev server (${PORTS.UI})`);
    }
  });

  it('prefers a positive-integer env var over the default', () => {
    assert.equal(resolveIpcPort('coinbase', { COINBASE_IPC_PORT: '9001' }), 9001);
    assert.equal(resolveIpcPort('gemini', { GEMINI_IPC_PORT: '9002' }), 9002);
    assert.equal(resolveIpcPort('cryptocom', { CRYPTOCOM_IPC_PORT: '9003' }), 9003);
  });

  it('falls back to the default on a missing, empty, zero, negative or non-numeric env value', () => {
    for (const bad of [undefined, '', '0', '-1', 'not-a-port']) {
      assert.equal(resolveIpcPort('coinbase', { COINBASE_IPC_PORT: bad }), PORTS.COINBASE_IPC);
    }
  });

  it('throws on an unknown exchange rather than silently returning a wrong port', () => {
    assert.throws(() => resolveIpcPort('kraken', {}), /unknown exchange/);
  });

  it('exposes the env-var and default maps used to build the resolution', () => {
    assert.deepEqual(Object.keys(IPC_PORT_ENV_VAR).sort(), ['coinbase', 'cryptocom', 'gemini']);
    assert.equal(IPC_PORT_DEFAULT.coinbase, PORTS.COINBASE_IPC);
    assert.equal(IPC_PORT_DEFAULT.gemini, PORTS.GEMINI_IPC);
    assert.equal(IPC_PORT_DEFAULT.cryptocom, PORTS.CRYPTOCOM_IPC);
  });

  it('.env.example matches ecosystem.config.cjs IPC port defaults without colliding with gateway or UI', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const content = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');

    for (const [exchange, defaultPort] of Object.entries(IPC_PORT_DEFAULT)) {
      const envVar = IPC_PORT_ENV_VAR[exchange];
      const match = content.match(new RegExp(`^${envVar}=(\\d+)`, 'm'));
      assert.ok(match, `.env.example should define ${envVar}`);
      const port = Number(match[1]);
      assert.equal(port, defaultPort, `${envVar} in .env.example should match PORTS default (${defaultPort})`);
      assert.notEqual(port, PORTS.API, `${envVar} must not collide with PORTS.API (${PORTS.API})`);
      assert.notEqual(port, PORTS.UI, `${envVar} must not collide with PORTS.UI (${PORTS.UI})`);

      const commentMatch = content.match(new RegExp(`#.*${exchange}.*\\(default:\\s*(\\d+)\\)`, 'i'));
      if (commentMatch) {
        assert.equal(Number(commentMatch[1]), defaultPort, `${exchange} default comment in .env.example should state ${defaultPort}`);
      }
    }
  });
});

