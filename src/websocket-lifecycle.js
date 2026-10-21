// @ts-check
const { connectWebSocket } = require('./websocket-connection');

const HEARTBEAT_INTERVAL = 30000;
const MAX_SILENT_INTERVALS = 2;
const HANDSHAKE_TIMEOUT = 15000;
const STABLE_CONNECTION_MS = 30000;
const RECONNECT_BASE_DELAY = 1000;
const MAX_RECONNECT_DELAY = 60000;
const FRAME_ERROR_LOG_INTERVAL = 60000;

/**
 * Tag an error thrown while handling one inbound frame so the lifecycle knows
 * which channel it came from and how to contain it. `failSafe` marks frames
 * that must not be dropped (user/order frames carrying fills and cancels): the
 * socket is terminated so the reconnect path re-subscribes and gap recovery
 * re-reads order state. Untagged and market-data errors drop just that frame.
 * @param {unknown} error
 * @param {string} channel
 * @param {boolean} [failSafe]
 * @returns {Error}
 */
const tagFrameError = (error, channel, failSafe = false) => {
  const tagged = error instanceof Error ? error : new Error(String(error));
  Object.assign(tagged, { frameChannel: channel, frameFailSafe: failSafe });
  return tagged;
};

/**
 * Own one feed's socket sessions and their timers. Exchange protocol work stays
 * in the feed; callbacks and delayed work may only act on their own live socket.
 *
 * Liveness is judged on inbound traffic. Every feed guarantees periodic frames
 * (Coinbase `heartbeats` channel, Gemini `heartbeat`, Crypto.com
 * `public/heartbeat`), so a socket that stays silent for MAX_SILENT_INTERVALS
 * heartbeat intervals is dead (NAT timeout, sleep, partition) even though the
 * runtime still reports it open. It is terminated so the usual close →
 * reconnect/backoff path runs. A socket still CONNECTING after
 * HANDSHAKE_TIMEOUT (endpoint accepts TCP but never answers the upgrade) is
 * terminated the same way, since connect() refuses to replace a connecting one.
 */
const createWebSocketLifecycle = ({
  url, exchange, logger, config, subscribe, handleMessage,
  name = 'WebSocket', subscribeDelay = 0, onOpen = () => {},
}) => {
  let session = null;
  let shouldReconnect = true;
  let reconnectAttempts = 0;
  let reconnectTimeout = null;
  /** @type {Map<string, { lastLoggedAt: number, suppressed: number }>} */
  const frameErrorLog = new Map();
  const isCurrent = current => session === current;
  const isOpen = current => isCurrent(current) && current.socket.isOpen();

  const clearReconnect = () => {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  };

  const retireSession = current => {
    clearTimeout(current.handshakeTimeout);
    clearTimeout(current.subscribeTimeout);
    clearTimeout(current.stableTimeout);
    clearInterval(current.heartbeatInterval);
    session = null;
  };

  const scheduleReconnect = () => {
    clearReconnect();
    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    logger.info(`🔄 [${exchange}] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts + 1})`, {
      lifecycle: 'reconnecting', delayMs: delay, reconnectAttempt: reconnectAttempts + 1,
    });
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      reconnectAttempts++;
      connect();
    }, delay);
  };

  // Backoff resets only once a connection proves stable, so an exchange that
  // accepts the upgrade and then drops us (auth/subscribe rejection, rate limit)
  // keeps growing the delay instead of retrying at the base delay forever.
  const markStable = current => {
    if (current.stable || !isCurrent(current)) return;
    current.stable = true;
    clearTimeout(current.stableTimeout);
    current.stableTimeout = null;
    reconnectAttempts = 0;
  };

  const startHeartbeat = current => {
    current.silentIntervals = 0;
    current.heartbeatInterval = setInterval(() => {
      if (!isOpen(current)) return;
      if (current.silentIntervals >= MAX_SILENT_INTERVALS) {
        const elapsedMs = current.silentIntervals * HEARTBEAT_INTERVAL;
        logger.error(`💀 [${exchange}] No inbound frame for ${elapsedMs / 1000}s — terminating dead WebSocket to trigger reconnect`, {
          silentIntervals: current.silentIntervals,
          elapsedMs,
        });
        current.socket.terminate();
        return;
      }
      current.silentIntervals++;
    }, HEARTBEAT_INTERVAL);
  };

  // A throw out of the frame handler would reach the process-wide
  // uncaughtException guard and exit the engine for every fund on the exchange.
  // Market-data frames are superseded by the next tick, so drop them (logging at
  // most once per interval per channel); fail-safe frames reconnect instead.
  /** @returns {boolean} whether the socket was terminated */
  const containFrameError = (current, error) => {
    const channel = error?.frameChannel || 'unknown';
    const failSafe = error?.frameFailSafe === true;
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    const entry = frameErrorLog.get(channel) || { lastLoggedAt: -Infinity, suppressed: 0 };
    if (failSafe || now - entry.lastLoggedAt >= FRAME_ERROR_LOG_INTERVAL) {
      logger.error(`❌ [${exchange}] ${name} ${channel} frame handler threw — ${failSafe ? 'terminating socket to reconnect and recover order state' : 'dropping frame'}: ${message}`, {
        lifecycle: 'frame-error', channel, failSafe, error: message,
        stack: error instanceof Error ? error.stack : undefined,
        suppressedSinceLastLog: entry.suppressed,
      });
      frameErrorLog.set(channel, { lastLoggedAt: now, suppressed: 0 });
    } else {
      entry.suppressed++;
      frameErrorLog.set(channel, entry);
    }
    if (!failSafe) return false;
    current.socket.terminate('frame handler failed');
    return true;
  };

  const connect = () => {
    if (session && (session.socket.isOpen() || session.socket.isConnecting())) return;
    if (session) retireSession(session);
    clearReconnect();
    logger.info(`🔌 [${exchange}] Connecting to ${name}...`, { lifecycle: 'connecting' });
    const socket = connectWebSocket(url);
    const current = { socket, connected: false, silentIntervals: 0, subscribeTimeout: null, stableTimeout: null, stable: false, subscribed: false, heartbeatInterval: null, handshakeTimeout: null };
    session = current;
    current.handshakeTimeout = setTimeout(() => {
      current.handshakeTimeout = null;
      if (!isCurrent(current) || !socket.isConnecting()) return;
      logger.error(`⏱️ [${exchange}] ${name} handshake not complete after ${HANDSHAKE_TIMEOUT / 1000}s — terminating to trigger reconnect`, {
        lifecycle: 'handshake-timeout', timeoutMs: HANDSHAKE_TIMEOUT,
      });
      socket.terminate();
    }, HANDSHAKE_TIMEOUT);

    socket.on('open', () => {
      if (!isOpen(current) || current.connected) return;
      clearTimeout(current.handshakeTimeout);
      current.handshakeTimeout = null;
      logger.info(`✅ [${exchange}] ${name} connected`, { lifecycle: 'connected' });
      current.connected = true;
      current.stableTimeout = setTimeout(() => markStable(current), STABLE_CONNECTION_MS);
      onOpen();
      const finishConnect = () => {
        current.subscribeTimeout = null;
        if (!isOpen(current)) return;
        subscribe(socket);
        if (!isOpen(current)) return;
        current.subscribed = true;
        startHeartbeat(current);
        config.onConnect?.();
      };
      if (subscribeDelay) current.subscribeTimeout = setTimeout(finishConnect, subscribeDelay);
      else finishConnect();
    });
    socket.on('message', data => {
      if (!isOpen(current)) return;
      current.silentIntervals = 0;
      let terminated = false;
      try {
        handleMessage(typeof data === 'string' ? data : data.toString(), socket);
      } catch (error) {
        terminated = containFrameError(current, error);
      }
      // A frame that forces a reconnect must not reset the backoff, or a
      // poisoned user stream would reconnect at the base delay forever.
      if (!terminated && current.subscribed) markStable(current);
    });
    socket.on('close', (code, reason) => {
      if (!isCurrent(current)) return;
      logger.info(`🔌 [${exchange}] ${name} closed: ${code} ${reason}`, {
        lifecycle: 'closed', code, reason: String(reason),
      });
      retireSession(current);
      config.onDisconnect?.();
      if (shouldReconnect && !session) scheduleReconnect();
    });
    socket.on('error', error => {
      if (!isCurrent(current)) return;
      logger.error(`❌ [${exchange}] ${name} error: ${error.message}`, { error: error.message });
      config.onError?.(error);
    });
  };

  const disconnect = () => {
    shouldReconnect = false;
    clearReconnect();
    if (session) {
      const current = session;
      // Invalidate first: close may emit synchronously or arrive after a new connect.
      retireSession(current);
      current.socket.close();
      config.onDisconnect?.();
    }
    logger.info(`🔌 [${exchange}] ${name} disconnected`, { lifecycle: 'disconnected' });
  };

  return {
    connect,
    disconnect,
    isActive: () => Boolean(session?.connected),
    getStatus: () => ({ connected: Boolean(session?.connected), reconnectAttempts }),
  };
};

module.exports = { createWebSocketLifecycle, tagFrameError };
