// @ts-check
/**
 * Realtime event bus for the operator admin UI.
 *
 * Owned replacement for the socket.io server. Every gateway HTTP listener
 * upgrades `GET <path>` to an RFC 6455 connection (src/ipc/ws-server.js) once
 * `authorize(req)` accepts the request, and the bus fans JSON events out to
 * every connection or to the members of a room.
 *
 * Wire protocol, one JSON object per text frame:
 *   server -> client  { t: 'open', id, pingInterval, pingTimeout }  (first frame)
 *                     { t: 'event', e: <name>, p: <payload> }
 *                     { t: 'ping' }
 *   client -> server  { t: 'sub' | 'unsub', r: <room> }
 *                     { t: 'event', e: <name>, p: <payload> }
 *                     { t: 'pong' }
 *
 * The server pings every `pingInterval` and terminates a connection that has
 * not answered within `pingTimeout` (engine.io's 25 s / 20 s). The client
 * treats `pingInterval + pingTimeout` of silence as a dead connection.
 *
 * Surface kept from socket.io so emitters keep their call shape: `emit(event,
 * payload)`, `to(room).emit(event, payload)`, `on('connection', handler)` and,
 * per socket, `id`, `rooms`, `on(event, handler)` (client events plus the local
 * `disconnect`), `emit`, `join`, `leave` and `disconnect()`.
 */
const crypto = require('node:crypto');
const { handshakeRefusal, refuseUpgrade, acceptUpgrade } = require('./ipc/ws-server');

const DEFAULT_PATH = '/realtime';
const PING_INTERVAL_MS = 25_000;
const PING_TIMEOUT_MS = 20_000;
// Client frames are subscriptions and small commands.
const MAX_CLIENT_PAYLOAD = 64 * 1024;
// A tab that stopped reading is dropped (it reconnects) instead of growing
// the gateway's write buffer without bound.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const PING_FRAME = JSON.stringify({ t: 'ping' });

/** @param {string} event @param {unknown} payload */
const eventFrame = (event, payload) => JSON.stringify({ t: 'event', e: event, p: payload });

/** @param {string | undefined} url */
const pathnameOf = (url) => {
  const raw = url || '/';
  const query = raw.indexOf('?');
  return query === -1 ? raw : raw.slice(0, query);
};

/**
 * @typedef {Object} RealtimeSocket
 * @property {string} id
 * @property {Set<string>} rooms
 * @property {boolean} connected
 * @property {(event: string, handler: (payload?: any) => void) => void} on
 * @property {(event: string, payload?: unknown) => void} emit
 * @property {(room: string) => void} join
 * @property {(room: string) => void} leave
 * @property {(code?: number, reason?: string) => void} disconnect
 */

/**
 * @param {{
 *   httpServer?: import('node:http').Server,
 *   path?: string,
 *   authorize?: (req: import('node:http').IncomingMessage) => boolean | Promise<boolean>,
 *   isStopping?: () => boolean,
 *   rooms?: Iterable<string> | null,
 *   pingInterval?: number,
 *   pingTimeout?: number,
 *   maxPayload?: number,
 *   maxBufferedBytes?: number,
 *   log?: (level: string, message: string) => void,
 * }} [options]
 */
const createRealtimeBus = ({
  httpServer,
  path = DEFAULT_PATH,
  authorize = () => true,
  isStopping = () => false,
  rooms = null,
  pingInterval = PING_INTERVAL_MS,
  pingTimeout = PING_TIMEOUT_MS,
  maxPayload = MAX_CLIENT_PAYLOAD,
  maxBufferedBytes = MAX_BUFFERED_BYTES,
  log = () => {},
} = {}) => {
  const joinable = rooms ? new Set(rooms) : null;
  /** @type {Map<string, RealtimeSocket>} */
  const sockets = new Map();
  /** @type {Map<string, Set<RealtimeSocket>>} */
  const members = new Map();
  /** @type {Set<(socket: RealtimeSocket, req: import('node:http').IncomingMessage) => void>} */
  const connectionHandlers = new Set();
  /** @type {WeakMap<RealtimeSocket, (text: string) => void>} */
  const senders = new WeakMap();
  /** @type {WeakSet<RealtimeSocket>} */
  const scopedStatusSockets = new WeakSet();
  /**
   * Last `regime:state` sent per fund, so only a change in the header-level
   * state (running, dry-run, lifecycle) is announced, not every status tick.
   * @type {Map<string, {exchange: string, pair: string, isRunning: boolean, isDryRun: boolean, lifecycle: string}>}
   */
  const lastRegimeState = new Map();
  /**
   * Last fund-data signature seen per fund (orders, cycles, realized P&L).
   * @type {Map<string, string>}
   */
  const lastRegimeData = new Map();
  /** @type {Set<import('./ipc/ws-server').WebSocketConnection>} */
  const live = new Set();
  let closing = false;
  /** @type {Promise<void> | null} */
  let closePromise = null;
  /** @type {(() => void) | null} */
  let resolveClose = null;

  const refusing = () => closing || isStopping();
  /** @param {RealtimeSocket} socket @param {string} text */
  const sendRaw = (socket, text) => senders.get(socket)?.(text);

  /** @param {{exchange: string, pair: string, isRunning: boolean, isDryRun: boolean, lifecycle: string}} state */
  const announceState = (state) => {
    const key = `${state.exchange}::${state.pair}`;
    const prev = lastRegimeState.get(key);
    if (prev && prev.isRunning === state.isRunning && prev.isDryRun === state.isDryRun && prev.lifecycle === state.lifecycle) return;
    lastRegimeState.set(key, state);
    const text = eventFrame('regime:state', state);
    for (const socket of sockets.values()) sendRaw(socket, text);
  };

  /**
   * Derive the compact `regime:state` notification from a full `regime:status`
   * emit and broadcast it to every socket when it differs from the last one
   * for that fund. The shell header needs only these three fields; this keeps
   * it off a status poll and off the full status stream.
   * @param {unknown} payload
   */
  const announceRegimeState = (payload) => {
    const data = /** @type {{exchange?: unknown, pair?: unknown, status?: any} | null} */ (payload);
    const status = data?.status;
    if (typeof data?.exchange !== 'string' || typeof data?.pair !== 'string' || typeof status?.isRunning !== 'boolean') return;
    announceState({
      exchange: data.exchange,
      pair: data.pair,
      isRunning: status.isRunning,
      isDryRun: Boolean(status.isDryRun),
      lifecycle: status.lifecycle?.lifecycle || 'active',
    });
  };

  /**
   * Tell every socket when a fund's stored data changes (an order placed,
   * filled or cancelled, a cycle closed), so pages that read the ledger, open
   * orders or summary re-read on this instead of a timer. The signature comes
   * from fields the status stream already carries; price ticks do not change
   * it. The first status seen after a gateway start only records a baseline:
   * clients reconcile on reconnect anyway.
   * @param {unknown} payload
   */
  const announceRegimeData = (payload) => {
    const data = /** @type {{exchange?: unknown, pair?: unknown, status?: any} | null} */ (payload);
    const status = data?.status;
    if (typeof data?.exchange !== 'string' || typeof data?.pair !== 'string' || !status || typeof status !== 'object') return;
    const position = status.position || {};
    const orderIds = Array.isArray(status.pendingOrders)
      ? status.pendingOrders.map((order) => order?.orderId ?? order?.id ?? '').join(',')
      : '';
    const signature = [
      status.orders?.total, status.orders?.entries, status.orders?.takeProfits, status.orders?.bodies, orderIds,
      position.cyclesCompleted, position.cycleBuys, position.realizedPnL, position.realizedAssetPnL,
      status.closedTradesSummary?.count, status.closedTradesSummary?.totalPnl,
    ].join('|');
    const key = `${data.exchange}::${data.pair}`;
    const prev = lastRegimeData.get(key);
    if (prev === signature) return;
    lastRegimeData.set(key, signature);
    if (prev === undefined) return;
    const text = eventFrame('regime:changed', { exchange: data.exchange, pair: data.pair });
    for (const socket of sockets.values()) sendRaw(socket, text);
  };

  const settleClose = () => {
    if (resolveClose && live.size === 0) {
      resolveClose();
      resolveClose = null;
    }
  };

  /**
   * @param {import('./ipc/ws-server').WebSocketConnection} connection
   * @param {import('node:http').IncomingMessage} req
   */
  const register = (connection, req) => {
    const id = crypto.randomBytes(12).toString('base64url');
    /** @type {Map<string, Set<Function>>} */
    const handlers = new Map();
    /** @type {Set<string>} */
    const joined = new Set();
    /** @type {NodeJS.Timeout | null} */
    let pingTimer = null;
    /** @type {NodeJS.Timeout | null} */
    let pongTimer = null;
    let connected = true;
    const scopedRegimeStatus = new URL(req.url || '/', 'http://localhost').searchParams.get('scopedRegimeStatus') === '1';

    /** @param {string} text */
    const send = (text) => {
      if (!connected) return;
      if (connection.bufferedAmount > maxBufferedBytes) {
        log('WARN', `Realtime client ${id} stopped reading; dropping it`);
        connection.terminate();
        return;
      }
      connection.send(text);
    };

    /** @param {string} event @param {unknown[]} args */
    const dispatch = (event, args) => {
      for (const handler of handlers.get(event) || []) {
        try {
          handler(...args);
        } catch (err) {
          log('ERROR', `Realtime ${event} handler failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

    const schedulePing = () => {
      pingTimer = setTimeout(() => {
        pingTimer = null;
        send(PING_FRAME);
        pongTimer = setTimeout(() => {
          log('INFO', `Realtime client ${id} missed its heartbeat; closing`);
          connection.terminate();
        }, pingTimeout);
        pongTimer.unref();
      }, pingInterval);
      pingTimer.unref();
    };

    /** @param {string} reason */
    const teardown = (reason) => {
      if (!connected) return;
      connected = false;
      if (pingTimer) clearTimeout(pingTimer);
      if (pongTimer) clearTimeout(pongTimer);
      pingTimer = pongTimer = null;
      for (const room of [...joined]) socket.leave(room);
      sockets.delete(id);
      dispatch('disconnect', [reason]);
      handlers.clear();
    };

    /** @type {RealtimeSocket} */
    const socket = {
      id,
      rooms: joined,
      get connected() { return connected; },
      on: (event, handler) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)?.add(handler);
      },
      emit: (event, payload) => send(eventFrame(event, payload)),
      join: (room) => {
        if (!connected) return;
        joined.add(room);
        if (!members.has(room)) members.set(room, new Set());
        members.get(room)?.add(socket);
      },
      leave: (room) => {
        joined.delete(room);
        const set = members.get(room);
        if (!set) return;
        set.delete(socket);
        if (set.size === 0) members.delete(room);
      },
      // Synchronous: handlers registered for `disconnect` (log-stream cleanup)
      // have run, and nothing more is delivered, before this returns.
      disconnect: (code = 1000, reason = '') => {
        teardown('server disconnect');
        connection.close(code, reason);
      },
    };

    /** @param {string} text */
    const onFrame = (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        msg = null;
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        socket.disconnect(1008, 'invalid message');
        return;
      }
      switch (msg.t) {
        case 'pong':
          if (!pongTimer) return;
          clearTimeout(pongTimer);
          pongTimer = null;
          schedulePing();
          return;
        case 'sub':
        case 'unsub':
          if (refusing() || typeof msg.r !== 'string' || (joinable && !joinable.has(msg.r) && !/^regime:status:(?:all|[^:]{1,256}:[^:]{1,256})$/.test(msg.r))) return;
          if (msg.t === 'sub') socket.join(msg.r);
          else socket.leave(msg.r);
          return;
        case 'event':
          // `disconnect` is local-only; a client cannot fire it.
          if (refusing() || typeof msg.e !== 'string' || msg.e === 'disconnect') return;
          dispatch(msg.e, [msg.p]);
          return;
        default:
          socket.disconnect(1008, 'invalid message');
      }
    };

    live.add(connection);
    sockets.set(id, socket);
    if (scopedRegimeStatus) scopedStatusSockets.add(socket);
    senders.set(socket, send);
    connection.on('message', (data, isBinary) => {
      if (!connected) return;
      if (isBinary) socket.disconnect(1003, 'binary frames are not supported');
      else onFrame(String(data));
    });
    // Protocol errors close the connection; the close event performs teardown.
    connection.on('error', () => {});
    connection.once('close', () => {
      teardown('transport close');
      live.delete(connection);
      settleClose();
    });

    connection.send(JSON.stringify({ t: 'open', id, pingInterval, pingTimeout }));
    schedulePing();
    for (const handler of connectionHandlers) {
      try {
        handler(socket, req);
      } catch (err) {
        log('ERROR', `Realtime connection handler failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   */
  const onUpgrade = (req, socket, head) => {
    socket.on('error', () => {});
    if (pathnameOf(req.url) !== path) return refuseUpgrade(socket, 404);
    if (refusing()) return refuseUpgrade(socket, 503);
    const refusal = handshakeRefusal(req);
    if (refusal) return refuseUpgrade(socket, refusal.status, refusal.headers);
    Promise.resolve()
      .then(() => authorize(req))
      .then((allowed) => {
        if (refusing()) return refuseUpgrade(socket, 503);
        if (!allowed) return refuseUpgrade(socket, 401);
        acceptUpgrade(req, socket, head, { maxPayload }, (connection) => register(connection, req));
      }, (err) => {
        // Rate-limited or busy credential checks carry their HTTP status.
        const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 401;
        refuseUpgrade(socket, status, err?.headers?.['Retry-After'] ? { 'Retry-After': String(err.headers['Retry-After']) } : {});
      });
  };

  /** @param {import('node:http').Server} server */
  const attach = (server) => {
    server.on('upgrade', onUpgrade);
  };

  if (httpServer) attach(httpServer);

  return {
    sockets,
    attach,
    /** Undo `attach` for a server that never served (failed late bind). @param {import('node:http').Server} server */
    detach: (server) => { server.removeListener('upgrade', onUpgrade); },
    /** @param {'connection'} event @param {(socket: RealtimeSocket, req: import('node:http').IncomingMessage) => void} handler */
    on: (event, handler) => {
      if (event !== 'connection') throw new TypeError(`Unsupported realtime bus event: ${event}`);
      connectionHandlers.add(handler);
    },
    /** @param {string} event @param {unknown} [payload] */
    emit: (event, payload) => {
      const text = eventFrame(event, payload);
      if (event === 'regime:status') {
        announceRegimeState(payload);
        announceRegimeData(payload);
      }
      for (const socket of sockets.values()) {
        if (event === 'regime:status' && scopedStatusSockets.has(socket)) {
          const data = /** @type {{exchange?: string, pair?: string} | null} */ (payload);
          const room = typeof data?.exchange === 'string' && typeof data?.pair === 'string'
            ? `regime:status:${encodeURIComponent(data.exchange)}:${encodeURIComponent(data.pair)}`
            : null;
          if (!socket.rooms.has('regime:status:all') && !(room && socket.rooms.has(room))) continue;
        }
        sendRaw(socket, text);
      }
    },
    /** @param {string} room */
    to: (room) => ({
      /** @param {string} event @param {unknown} [payload] */
      emit: (event, payload) => {
        const set = members.get(room);
        if (!set) return;
        const text = eventFrame(event, payload);
        for (const socket of set) sendRaw(socket, text);
      },
    }),
    /** Close every connection now (credential change); clients reconnect and re-authenticate. */
    disconnectSockets: (code = 1008, reason = 'Operator credentials changed') => {
      for (const socket of [...sockets.values()]) socket.disconnect(code, reason);
    },
    /**
     * The gateway lost an exchange's engine: no status will follow, so announce
     * its running funds as stopped, then forget its funds so the first status
     * after recovery is announced again even when it matches what was sent.
     * @param {string} exchange
     */
    engineDown: (exchange) => {
      for (const [key, state] of [...lastRegimeState]) {
        if (state.exchange !== exchange) continue;
        if (state.isRunning) announceState({ ...state, isRunning: false });
        lastRegimeState.delete(key);
      }
    },
    /** Refuse new upgrades and close every connection; resolves once all are gone. */
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      lastRegimeState.clear();
      lastRegimeData.clear();
      closePromise = new Promise((resolve) => { resolveClose = resolve; });
      for (const socket of [...sockets.values()]) socket.disconnect(1001, 'Gateway is shutting down');
      settleClose();
      return closePromise;
    },
  };
};

module.exports = { createRealtimeBus };
