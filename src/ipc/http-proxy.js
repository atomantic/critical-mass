// @ts-check
/**
 * HTTP Reverse Proxy
 *
 * Lightweight reverse proxy using Node's built-in http module.
 * Forwards requests from the gateway to engine processes.
 * Returns 503 if the target engine is unavailable.
 */

const http = require('http');
const { log } = require('../logger');

/**
 * Create an Express middleware that proxies requests to a target host:port
 * @param {string} targetHost - Target hostname (e.g. '127.0.0.1')
 * @param {number} targetPort - Target port (e.g. 5572)
 * @param {string} name - Human-readable name for logs
 * @returns {import('express').RequestHandler}
 */
const createProxy = (targetHost, targetPort, name) => {
  return (req, res) => {
    const options = {
      hostname: targetHost,
      port: targetPort,
      path: req.originalUrl,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${targetHost}:${targetPort}`,
      },
      timeout: 30_000,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
        res.status(503).json({
          error: `${name} engine is not available. It may be starting up or has crashed.`,
          code: 'ENGINE_UNAVAILABLE',
        });
      } else {
        log('ERROR', `🔗 [${name}] Proxy error: ${err.message}`);
        res.status(502).json({ error: `Proxy error: ${err.message}` });
      }
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      res.status(504).json({ error: `${name} engine request timed out` });
    });

    // Pipe the request body to the proxy
    if (req.readable) {
      req.pipe(proxyReq, { end: true });
    } else {
      // Body already parsed by express.json() — re-serialize
      if (req.body && Object.keys(req.body).length > 0) {
        const bodyStr = JSON.stringify(req.body);
        proxyReq.setHeader('content-type', 'application/json');
        proxyReq.setHeader('content-length', Buffer.byteLength(bodyStr));
        proxyReq.end(bodyStr);
      } else {
        proxyReq.end();
      }
    }
  };
};

module.exports = { createProxy };
