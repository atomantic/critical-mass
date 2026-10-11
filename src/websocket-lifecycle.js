// @ts-check
const WebSocket = require('ws');

const HEARTBEAT_INTERVAL = 30000;
const MAX_MISSED_PONGS = 2;
const RECONNECT_BASE_DELAY = 1000;
const MAX_RECONNECT_DELAY = 60000;

/**
 * Own one feed's socket sessions and their timers. Exchange protocol work stays
 * in the feed; callbacks and delayed work may only act on their own live socket.
 */
const createWebSocketLifecycle = ({
  url, exchange, logger, config, subscribe, handleMessage,
  name = 'WebSocket', subscribeDelay = 0, onOpen = () => {},
}) => {
  let session = null;
  let shouldReconnect = true;
  let reconnectAttempts = 0;
  let reconnectTimeout = null;
  const isCurrent = current => session === current;
  const isOpen = current => isCurrent(current) && current.socket.readyState === WebSocket.OPEN;

  const clearReconnect = () => {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  };

  const retireSession = current => {
    clearTimeout(current.subscribeTimeout);
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

  const startHeartbeat = current => {
    current.missedPongs = 0;
    current.heartbeatInterval = setInterval(() => {
      if (!isOpen(current)) return;
      if (current.missedPongs >= MAX_MISSED_PONGS) {
        logger.error(`💀 [${exchange}] No pong after ${current.missedPongs} pings (${(current.missedPongs * HEARTBEAT_INTERVAL) / 1000}s) — terminating dead WebSocket to trigger reconnect`, {
          missedPongs: current.missedPongs,
          elapsedMs: current.missedPongs * HEARTBEAT_INTERVAL,
        });
        current.socket.terminate();
        return;
      }
      current.missedPongs++;
      current.socket.ping();
    }, HEARTBEAT_INTERVAL);
  };

  const connect = () => {
    if (session && [WebSocket.OPEN, WebSocket.CONNECTING].includes(session.socket.readyState)) return;
    if (session) retireSession(session);
    clearReconnect();
    logger.info(`🔌 [${exchange}] Connecting to ${name}...`, { lifecycle: 'connecting' });
    const socket = new WebSocket(url);
    const current = { socket, connected: false, missedPongs: 0, subscribeTimeout: null, heartbeatInterval: null };
    session = current;

    socket.on('open', () => {
      if (!isOpen(current) || current.connected) return;
      logger.info(`✅ [${exchange}] ${name} connected`, { lifecycle: 'connected' });
      current.connected = true;
      reconnectAttempts = 0;
      onOpen();
      const finishConnect = () => {
        current.subscribeTimeout = null;
        if (!isOpen(current)) return;
        subscribe(socket);
        if (!isOpen(current)) return;
        startHeartbeat(current);
        config.onConnect?.();
      };
      if (subscribeDelay) current.subscribeTimeout = setTimeout(finishConnect, subscribeDelay);
      else finishConnect();
    });
    socket.on('message', data => {
      if (!isOpen(current)) return;
      current.missedPongs = 0;
      handleMessage(data.toString(), socket);
    });
    socket.on('pong', () => {
      if (isOpen(current)) current.missedPongs = 0;
    });
    socket.on('close', (code, reason) => {
      if (!isCurrent(current)) return;
      logger.info(`🔌 [${exchange}] ${name} closed: ${code} ${reason}`, {
        lifecycle: 'closed', code, reason: reason.toString(),
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

module.exports = { createWebSocketLifecycle };
