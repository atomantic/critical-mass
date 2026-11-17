// @ts-check
/**
 * Shared fake-Express harness for route tests.
 *
 * - createFakeApp(): records handlers by "METHOD /path" in `handlers` and exposes
 *   get/put/post/delete registrars.
 * - createRes(): minimal response object with status()/json() that records
 *   `statusCode` and `body`.
 * - invoke(app, key, req): calls the handler registered under `key` with a
 *   default { body, params, query } request merged with `req`, and returns the res.
 */

const createFakeApp = () => {
  const handlers = {};
  const register = (method) => (route, handler) => { handlers[`${method} ${route}`] = handler; };
  return {
    handlers,
    get: register('GET'),
    put: register('PUT'),
    post: register('POST'),
    delete: register('DELETE'),
  };
};

const createRes = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

const invoke = async (app, key, req = {}) => {
  const res = createRes();
  await app.handlers[key]({ body: {}, params: {}, query: {}, ...req }, res);
  return res;
};

module.exports = { createFakeApp, createRes, invoke };
