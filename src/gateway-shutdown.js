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

    // Every teardown step runs even when an earlier one fails: a producer
    // that cannot persist its state (e.g. a full disk) must not skip the
    // notifier drain, which would drop the queued alerts about that fault.
    let failed = false;
    const runStep = async (name, step) => {
      try {
        await step();
      } catch (err) {
        failed = true;
        log('ERROR', `Gateway shutdown: stopping ${name} failed: ${err.message}`);
      }
    };

    Promise.resolve().then(async () => {
      await cancelSchedules();
      // Producers (UpDown, Sentinel, log tails) run on their own timers and
      // save their own state when stopped. Stop them before the drain so a
      // drain that hits the deadline cannot skip that save — and because
      // UpDown's tracked startup lock wait ends only when UpDown stops, which
      // would otherwise hold the drain until the deadline. They are stopped
      // again below in case drained work (a backup's writer resume) restarted one.
      await runStep('producers', stopProducers);
      await drain();
      if (finished) return;
      for (const [name, step] of [['producers', stopProducers], ['notifier', stopNotifier], ['IPC', disconnectIPC], ['listeners', closeListeners]]) {
        await runStep(name, step);
      }
      log(failed ? 'ERROR' : 'INFO', failed ? 'Gateway shutdown finished with errors' : 'Gateway shutdown complete');
      complete(failed ? 1 : 0);
    }).catch((err) => {
      log('ERROR', `Gateway shutdown failed: ${err.message}`);
      complete(1);
    });
    return shutdownPromise;
  };

  return { track, middleware, handler, routes, shutdown, isStopping: () => stopping };
};

const closeGatewayListeners = async (bus, servers) => {
  // The bus closes every realtime connection on every listener (upgraded
  // sockets hold server.close() open until they end). Start every HTTP close
  // alongside it; ERR_SERVER_NOT_RUNNING from an already closed one is harmless.
  await Promise.all([
    bus.close(),
    ...servers.map((server) => new Promise((resolve, reject) => {
      server.close((err) => err && err.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(err) : resolve());
      server.closeIdleConnections?.();
    })),
  ]);
};

module.exports = { createGatewayShutdown, closeGatewayListeners, SHUTDOWN_TIMEOUT_MS };
