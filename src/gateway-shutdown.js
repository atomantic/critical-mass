// Own gateway work independently of HTTP socket lifetime: a disconnected
// caller can still have an exchange operation completing its durable booking.
const SHUTDOWN_TIMEOUT_MS = 30_000;

const createGatewayShutdown = ({
  cancelSchedules,
  stopProducers,
  stopNotifier,
  disconnectIPC,
  closeListeners,
  log,
  exit = (code) => process.exit(code),
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
}) => {
  const pending = new Set();
  let stopping = false;
  let shutdownPromise;

  const track = (work) => {
    const promise = Promise.resolve(work);
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };

  const middleware = (req, res, next) => {
    // Reject reads too: several read handlers use IPC or refresh caches, and
    // allowing them during teardown would continually extend the drain.
    if (stopping) return res.status(503).json({ success: false, error: 'Gateway is shutting down' });
    track(new Promise((resolve) => {
      const complete = () => {
        res.off('finish', complete);
        res.off('close', complete);
        resolve();
      };
      res.once('finish', complete);
      res.once('close', complete);
    }));
    next();
  };

  const handler = (fn) => (req, res, next) => {
    const result = fn(req, res, next);
    return result && typeof result.then === 'function' ? track(result) : result;
  };

  // Route modules receive the normal registration surface with promise
  // ownership added. This covers raw async handlers as well as asyncRoute().
  const routes = (app) => Object.fromEntries(
    ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'].map((method) => [method,
      (...args) => app[method](...args.flat(Infinity).map((arg) => typeof arg === 'function' ? handler(arg) : arg)),
    ])
  );

  const drain = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };

  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    log('INFO', `Received ${signal}, draining gateway work...`);
    let finished = false;
    let finish;
    shutdownPromise = new Promise((resolve) => { finish = resolve; });
    const complete = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      finish(code);
      exit(code);
    };
    const deadline = setTimeout(() => {
      log('WARN', 'Gateway shutdown deadline exceeded; exiting with recovery state intact');
      complete(1);
    }, timeoutMs);

    Promise.resolve().then(async () => {
      await cancelSchedules();
      await drain();
      if (finished) return;
      await stopProducers();
      await stopNotifier();
      await disconnectIPC();
      await closeListeners();
      log('INFO', 'Gateway shutdown complete');
      complete(0);
    }).catch((err) => {
      log('ERROR', `Gateway shutdown failed: ${err.message}`);
      complete(1);
    });
    return shutdownPromise;
  };

  return { track, middleware, handler, routes, shutdown, isStopping: () => stopping };
};

const closeGatewayListeners = async (io, servers, engines = [io.engine]) => {
  // io.attach() replaces io.engine; older listener transports still own
  // connected clients (even handshakes not yet admitted to a namespace).
  for (const engine of engines) engine?.close();
  // Socket.IO may also close its last attached HTTP server. Start every HTTP
  // close as well; ERR_SERVER_NOT_RUNNING is then harmless.
  await Promise.all([
    new Promise((resolve, reject) => {
      Promise.resolve(io.close((err) => err && err.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(err) : resolve())).catch(reject);
    }),
    ...servers.map((server) => new Promise((resolve, reject) => {
      server.close((err) => err && err.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(err) : resolve());
      server.closeIdleConnections?.();
    })),
  ]);
};

module.exports = { createGatewayShutdown, closeGatewayListeners, SHUTDOWN_TIMEOUT_MS };
