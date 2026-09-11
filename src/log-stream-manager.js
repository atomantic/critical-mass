'use strict';

// PM2 log-tail child lifecycle, extracted from server.js so the exit/
// replacement/unsubscribe races can be unit tested without a real PM2
// binary, a real child_process, or a real socket.io server (see #448).

/**
 * Registry of active PM2 log-tail children, keyed by socket id.
 */
const createLogStreamRegistry = () => {
  const streams = new Map(); // socketId -> { process, processName }

  const start = (key, processName, childProcess) => {
    const existing = streams.get(key);
    if (existing?.process) existing.process.kill();
    streams.set(key, { process: childProcess, processName });
  };

  // Deliberate teardown (explicit unsubscribe, socket disconnect). Kills the
  // child and removes it synchronously so its later 'close'/'error' event is
  // a no-op in `end()` below — no spurious terminal notification.
  const stop = (key) => {
    const entry = streams.get(key);
    if (!entry?.process) return null;
    entry.process.kill();
    streams.delete(key);
    return entry;
  };

  // Called from a child's own 'close'/'error' handler. Only tears down and
  // returns the entry when `childProcess` is still the active stream for
  // `key` — this is what stops a delayed close on an already-killed or
  // already-replaced child from clobbering a newer subscription, and what
  // dedupes an 'error' immediately followed by 'close' on the same child
  // into a single terminal notification.
  const end = (key, childProcess) => {
    const entry = streams.get(key);
    if (!entry || entry.process !== childProcess) return null;
    streams.delete(key);
    return entry;
  };

  const get = (key) => streams.get(key);
  const entries = () => streams.entries();
  const clear = () => streams.clear();

  return { start, stop, end, get, entries, clear };
};

/**
 * Wires the `logs:subscribe` / `logs:unsubscribe` / `logs:flush` handlers
 * for one connected socket. `spawnFn` and `log` are injected so tests can
 * supply a fake child (plain EventEmitter with stdout/stderr emitters) and
 * capture emitted socket events / log lines.
 */
const registerLogStreamHandlers = ({ socket, registry, spawnFn, log, allowedProcesses }) => {
  socket.on('logs:subscribe', ({ processName, lines } = {}) => {
    if (!allowedProcesses.has(processName)) {
      socket.emit('logs:error', { error: `Invalid process: ${processName}` });
      return;
    }
    const tailLines = Math.min(Math.max(parseInt(lines, 10) || 500, 1), 5000);

    const logProcess = spawnFn('pm2', ['logs', processName, '--raw', '--lines', String(tailLines)], { shell: false });
    registry.start(socket.id, processName, logProcess);

    let stdoutBuf = '';
    let stderrBuf = '';

    logProcess.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const parts = stdoutBuf.split('\n');
      stdoutBuf = parts.pop();
      for (const line of parts) {
        if (line.trim()) socket.emit('logs:line', { processName, line, type: 'stdout', timestamp: Date.now() });
      }
    });

    logProcess.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      const parts = stderrBuf.split('\n');
      stderrBuf = parts.pop();
      for (const line of parts) {
        if (line.trim()) socket.emit('logs:line', { processName, line, type: 'stderr', timestamp: Date.now() });
      }
    });

    // Emits at most one `logs:terminal` for this child, whether it fails to
    // spawn, exits cleanly, or crashes — and never for a child that was
    // deliberately killed (unsubscribe/replace/disconnect already removed
    // it from the registry via `stop()`/`start()`).
    const endStream = (reason, level, detail = {}) => {
      const entry = registry.end(socket.id, logProcess);
      if (!entry) return;
      socket.emit('logs:terminal', { processName, reason, ...detail });
      log(level, `📋 Log stream ended for ${processName} → ${socket.id} (${reason}${detail.message ? `: ${detail.message}` : ''})`);
    };

    logProcess.on('error', (err) => endStream('error', 'ERROR', { message: err.message }));
    logProcess.on('close', (code, signal) => {
      endStream(code === 0 ? 'exited' : 'crashed', code === 0 ? 'INFO' : 'ERROR', { code, signal });
    });

    socket.emit('logs:subscribed', { processName });
    log('INFO', `📋 Log stream started for ${processName} (${tailLines} lines) → ${socket.id}`);
  });

  socket.on('logs:unsubscribe', () => {
    const entry = registry.stop(socket.id);
    if (entry) {
      socket.emit('logs:unsubscribed');
      log('INFO', `📋 Log stream stopped for ${entry.processName} → ${socket.id}`);
    }
  });

  socket.on('logs:flush', ({ processName } = {}) => {
    if (!allowedProcesses.has(processName)) {
      socket.emit('logs:error', { error: `Invalid process: ${processName}` });
      return;
    }
    const flushProc = spawnFn('pm2', ['flush', processName], { shell: false });
    let output = '';
    flushProc.stdout.on('data', (chunk) => { output += chunk.toString(); });
    flushProc.stderr.on('data', (chunk) => { output += chunk.toString(); });
    flushProc.on('close', (code) => {
      socket.emit('logs:flushed', { processName, success: code === 0 });
      log('INFO', `📋 Log flush ${code === 0 ? 'succeeded' : 'failed'} for ${processName}`);
    });
    flushProc.on('error', (err) => {
      socket.emit('logs:flushed', { processName, success: false });
      log('ERROR', `📋 Log flush error for ${processName}: ${err.message}`);
    });
  });
};

const disconnectLogStream = ({ socket, registry, log }) => {
  const entry = registry.stop(socket.id);
  if (entry) {
    log('INFO', `📋 Log stream cleaned up for ${entry.processName} → ${socket.id}`);
  }
};

module.exports = { createLogStreamRegistry, registerLogStreamHandlers, disconnectLogStream };
