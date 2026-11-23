// @ts-check
/**
 * Crypto.com public index socket (`index.<instrument>`, about one value per
 * second). Market data only: no keys, no user channel.
 */

const { createWebSocketLifecycle } = require('../websocket-lifecycle');
const { safeJsonParse } = require('../shared-utils');
const { createContextLogger } = require('../logger');

const CRYPTOCOM_WS_URL = 'wss://stream.crypto.com/exchange/v1/market';
const POST_CONNECT_DELAY = 1000; // the exchange rate-limits a subscribe sent on open

/**
 * @param {{instrument?: string, onValue: (v: {value: number, timestamp: number}) => void, onConnect?: () => void, onDisconnect?: () => void}} options
 */
const createIndexClient = ({ instrument = 'BTCUSD-INDEX', onValue, onConnect, onDisconnect }) => {
  const logger = createContextLogger({ exchange: 'cryptocom', instrument });
  let requestId = 1;

  const subscribe = (ws) => {
    ws.send(JSON.stringify({ id: requestId++, method: 'subscribe', params: { channels: [`index.${instrument}`] } }));
  };

  const handleMessage = (data, ws) => {
    const message = safeJsonParse(data);
    if (!message) return;
    if (message.method === 'public/heartbeat') {
      ws.send(JSON.stringify({ id: message.id, method: 'public/respond-heartbeat' }));
      return;
    }
    if (message.method === 'subscribe' && message.code) {
      logger.error(`❌ [cryptocom] Index subscription error: ${message.message || message.code}`, { code: message.code });
      return;
    }
    const result = message.result;
    if (result?.channel !== 'index' || !Array.isArray(result.data)) return;
    for (const item of result.data) {
      const value = parseFloat(item?.v);
      if (Number.isFinite(value) && value > 0 && Number.isFinite(item.t)) onValue({ value, timestamp: item.t });
    }
  };

  return createWebSocketLifecycle({
    url: CRYPTOCOM_WS_URL, exchange: 'cryptocom', logger, config: { onConnect, onDisconnect }, subscribe, handleMessage,
    name: 'Crypto.com index WebSocket', subscribeDelay: POST_CONNECT_DELAY,
  });
};

module.exports = { createIndexClient };
