// @ts-check
const { it } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns');
const http = require('node:http');
const net = require('node:net');

it('safeFetch refuses DNS rebinding before a real family-autoselection connection reaches a private service', async (t) => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.end('synthetic private data');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const previousAutoSelectFamily = net.getDefaultAutoSelectFamily();
  net.setDefaultAutoSelectFamily(true);
  t.after(() => net.setDefaultAutoSelectFamily(previousAutoSelectFamily));
  let lookups = 0;
  t.mock.method(dns, 'lookup', (_hostname, options, callback) => {
    assert.equal(options.all, true, 'both preflight and the real Node connection must use address arrays');
    const address = ++lookups === 1 ? '104.21.0.1' : '127.0.0.1';
    queueMicrotask(() => callback(null, [{ address, family: 4 }]));
  });
  // Load after stubbing: validateEndpointUrl captures a promisified lookup.
  const modulePath = require.resolve('../src/url-validator');
  delete require.cache[modulePath];
  t.after(() => { delete require.cache[modulePath]; });
  const { safeFetch } = require(modulePath);

  await assert.rejects(() => safeFetch(`http://rebound.invalid:${server.address().port}/fixture`, {
    signal: AbortSignal.timeout(3000),
  }), /Blocked private\/reserved IPv4/);
  assert.equal(lookups, 2);
  assert.equal(requests, 0, 'the private service must receive no HTTP request');
});
