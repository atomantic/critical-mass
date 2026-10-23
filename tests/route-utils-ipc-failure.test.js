// @ts-check
// Direct unit tests for the engine-IPC failure contract in route-utils.js
// (engineError -> ipcFailureResponse / sendIpcFailure, and createIPCResolver).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  engineError, ipcFailureKind, ipcFailureResponse, sendIpcFailure, createIPCResolver, getSafeIPC,
} = require('../src/routes/route-utils');
const { IPC_ERROR_CODE, engineBusy } = require('../src/ipc/ipc-protocol');

const coded = (message, code) => Object.assign(new Error(message), code ? { code } : {});

const fakeRes = () => {
  const res = {
    statusCode: undefined,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  return res;
};

describe('engineError + ipcFailureResponse', () => {
  it('maps transport, timeout and untagged rejections to 503 with the "Engine unavailable:" prefix', () => {
    for (const [err, kind] of [
      [coded('socket gone', IPC_ERROR_CODE.TRANSPORT), IPC_ERROR_CODE.TRANSPORT],
      [coded('deadline exceeded', IPC_ERROR_CODE.TIMEOUT), IPC_ERROR_CODE.TIMEOUT],
      [coded('plain rejection'), IPC_ERROR_CODE.TRANSPORT],
      [coded('weird', 'SOMETHING_ELSE'), IPC_ERROR_CODE.TRANSPORT],
    ]) {
      const result = engineError(err);
      assert.equal(result.success, false);
      assert.equal(result.error, `Engine unavailable: ${err.message}`);
      assert.equal(ipcFailureKind(result), kind);
      const { status, body } = ipcFailureResponse(result);
      assert.equal(status, 503);
      assert.equal(body, result);
    }
  });

  it('tolerates a non-Error rejection', () => {
    const result = engineError(undefined);
    assert.equal(ipcFailureResponse(result).status, 503);
    assert.match(result.error, /^Engine unavailable:/);
  });

  it('maps a handler-coded rejection to 500 with a generic message that hides the raw text', () => {
    const result = engineError(coded('ENOENT: /secret/path/fund.json', IPC_ERROR_CODE.HANDLER));
    const { status, body } = ipcFailureResponse(result);
    assert.equal(status, 500);
    assert.equal(ipcFailureKind(result), IPC_ERROR_CODE.HANDLER);
    assert.equal(body.success, false);
    assert.doesNotMatch(body.error, /ENOENT|secret|fund\.json/);
    assert.doesNotMatch(body.error, /^Engine unavailable/);
    assert.equal(JSON.stringify(body).includes('secret'), false);
  });

  it('keeps the failure kind and status out of the serialized body', () => {
    const result = engineError(coded('socket gone', IPC_ERROR_CODE.TRANSPORT));
    assert.deepEqual(Object.keys(result).sort(), ['error', 'success']);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { success: false, error: 'Engine unavailable: socket gone' });
  });

  it('uses an engine domain reply\'s explicit 4xx/5xx statusCode', () => {
    for (const statusCode of [400, 404, 409, 422, 503]) {
      const reply = { success: false, error: 'nope', statusCode };
      const { status, body } = ipcFailureResponse(reply);
      assert.equal(status, statusCode);
      assert.equal(body, reply);
    }
    assert.equal(ipcFailureKind({ success: false, statusCode: 404 }), null);
  });

  it('preserves the structured engine-busy refusal as HTTP 503', () => {
    const reply = engineBusy();
    const res = fakeRes();
    sendIpcFailure(res, reply);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(JSON.parse(JSON.stringify(res.body)), reply);
  });

  it('defaults a domain reply without a usable statusCode to 400', () => {
    for (const reply of [{ success: false }, { success: false, statusCode: 200 }, { success: false, statusCode: 99 },
      { success: false, statusCode: 600 }, { success: false, statusCode: '404' }, { success: false, statusCode: 404.5 }, null]) {
      assert.equal(ipcFailureResponse(reply).status, 400, JSON.stringify(reply));
    }
  });
});

describe('sendIpcFailure', () => {
  it('writes the mapped status and body to the response', () => {
    const transport = fakeRes();
    sendIpcFailure(transport, engineError(coded('timed out', IPC_ERROR_CODE.TIMEOUT)));
    assert.equal(transport.statusCode, 503);
    assert.deepEqual(transport.body, { success: false, error: 'Engine unavailable: timed out' });

    const handler = fakeRes();
    sendIpcFailure(handler, engineError(coded('boom', IPC_ERROR_CODE.HANDLER)));
    assert.equal(handler.statusCode, 500);
    assert.doesNotMatch(handler.body.error, /boom/);

    const domain = fakeRes();
    sendIpcFailure(domain, { success: false, error: 'bad pair', statusCode: 404 });
    assert.equal(domain.statusCode, 404);
    assert.deepEqual(domain.body, { success: false, error: 'bad pair', statusCode: 404 });

    const bare = fakeRes();
    sendIpcFailure(bare, { success: false });
    assert.equal(bare.statusCode, 400);
  });

  it('returns the response so handlers can `return sendIpcFailure(...)`', () => {
    const res = fakeRes();
    assert.equal(sendIpcFailure(res, { success: false }), res);
  });
});

describe('createIPCResolver / getSafeIPC', () => {
  it('returns the registered client for a known exchange', () => {
    const client = { request: async () => 'ok' };
    const resolve = createIPCResolver({ coinbase: client });
    assert.equal(resolve('coinbase'), client);
  });

  it('returns a client whose request rejects with the original "No IPC client" error, which surfaces as 503', async () => {
    const resolve = createIPCResolver({ coinbase: { request: async () => 'ok' } });
    for (const exchange of ['gemini', 'toString', '__proto__']) {
      const ipc = resolve(exchange);
      await assert.rejects(() => ipc.request('x'), { message: `No IPC client for exchange: ${exchange}` });
      const result = await ipc.request('x').catch(engineError);
      assert.equal(ipcFailureResponse(result).status, 503);
      assert.equal(result.error, `Engine unavailable: No IPC client for exchange: ${exchange}`);
    }
  });

  it('rejects a registered entry that lacks a request function', async () => {
    const ipc = getSafeIPC({ coinbase: {} }, 'coinbase');
    await assert.rejects(() => ipc.request(), /No IPC client for exchange: coinbase/);
  });
});
