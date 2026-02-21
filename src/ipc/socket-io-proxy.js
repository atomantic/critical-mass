// @ts-check
/**
 * Socket.IO Proxy
 *
 * Drop-in replacement for Socket.IO's `io` object that forwards
 * .emit() and .to(room).emit() calls over IPC to the gateway process,
 * which re-emits them on the real Socket.IO server.
 *
 * Engine processes use this instead of a real Socket.IO server so the
 * admin UI only connects to the gateway (:5563).
 */

/**
 * Create a Socket.IO-compatible proxy backed by an IPC server
 * @param {Object} ipcServer - IPC server instance (from ipc-server.js)
 * @returns {Object} Socket.IO-compatible `io` object
 */
const createSocketIOProxy = (ipcServer) => {
  /** @type {Map<string, Set<Function>>} event -> handlers (for io.on('connection', ...)) */
  const localHandlers = new Map();

  const proxy = {
    /**
     * Emit an event to all connected clients (via gateway)
     * @param {string} channel - Event name
     * @param  {...any} args - Event data
     */
    emit: (channel, ...args) => {
      ipcServer.broadcast(channel, args.length === 1 ? args[0] : args);
    },

    /**
     * Target a specific Socket.IO room
     * @param {string} room - Room name
     * @returns {{ emit: Function }}
     */
    to: (room) => ({
      emit: (channel, ...args) => {
        ipcServer.broadcast(channel, args.length === 1 ? args[0] : args, { room });
      },
    }),

    /**
     * Register a local event handler (no-op for most engine uses; included
     * for API compatibility so code that calls io.on('connection', ...) doesn't crash)
     * @param {string} event
     * @param {Function} handler
     */
    on: (event, handler) => {
      if (!localHandlers.has(event)) localHandlers.set(event, new Set());
      localHandlers.get(event).add(handler);
    },
  };

  return proxy;
};

module.exports = { createSocketIOProxy };
