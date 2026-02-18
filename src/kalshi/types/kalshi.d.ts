/**
 * Type definitions for Kalshi API
 */

/** Environment type for API endpoints */
export type KalshiEnvironment = 'demo' | 'prod';

/** API keys configuration */
export interface KalshiKeys {
  keyId: string;
  privateKeyPem: string;
  environment: KalshiEnvironment;
}

/** Key validation result */
export interface KeyValidationResult {
  valid: boolean;
  errors: string[];
}

/** Masked keys for display (secrets hidden) */
export interface MaskedKeys {
  keyId: string;
  privateKeyPem: string;
  environment: KalshiEnvironment;
  hasKeys: boolean;
}

/** Balance response from API */
export interface BalanceResponse {
  balance: number;
  payout?: number;
}

/** Formatted balance for display */
export interface FormattedBalance {
  available: number;
  total?: number;
  inPositions?: number;
}

/** Connection test result */
export interface ConnectionTestResult {
  success: boolean;
  balance: FormattedBalance;
}

/** Market timeframe classification */
export type MarketTimeframe = '15min' | 'hourly' | '6hour' | 'daily' | 'weekly' | 'game' | 'unknown';

/** Market type classification */
export type MarketType = 'crypto' | 'sports' | 'other';

/** Crypto asset types */
export type CryptoAsset = 'BTC' | 'ETH' | 'SOL' | 'DOGE';

/** Sports league types */
export type SportsLeague = 'NFL' | 'NBA' | 'MLB' | 'NHL' | 'NCAAF' | 'NCAAB' | 'MLS' | 'SOCCER';

/** Market classification result */
export interface MarketClassification {
  type: MarketType;
  asset?: CryptoAsset;
  sport?: SportsLeague;
  timeframe: MarketTimeframe;
}

/** Raw market from Kalshi API */
export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle?: string;
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  volume?: number;
  volume_24h?: number;
  open_interest?: number;
  close_time?: string;
  expiration_time?: string;
  status: 'active' | 'closed' | 'settled';
  result?: 'yes' | 'no' | null;
}

/** Market with classification added */
export interface ClassifiedMarket extends KalshiMarket, MarketClassification {}

/** Orderbook level */
export interface OrderbookLevel {
  price: number;
  quantity: number;
}

/** Orderbook response */
export interface Orderbook {
  ticker: string;
  yes: OrderbookLevel[];
  no: OrderbookLevel[];
}

/** Market with details including orderbook */
export interface MarketWithDetails extends ClassifiedMarket {
  orderbook: Orderbook;
}

/** Implied probability calculation */
export interface ImpliedProbability {
  yes: number;
  no: number;
  spread: number;
}

/** Position from API */
export interface KalshiPosition {
  ticker: string;
  event_ticker: string;
  position: number;
  market_exposure: number;
  realized_pnl: number;
  resting_orders_count: number;
}

/** Order side */
export type OrderSide = 'yes' | 'no';

/** Order action */
export type OrderAction = 'buy' | 'sell';

/** Order type */
export type OrderType = 'limit' | 'market';

/** Order status */
export type OrderStatus = 'pending' | 'resting' | 'filled' | 'canceled' | 'expired';

/** Order request */
export interface OrderRequest {
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  count: number;
  type: OrderType;
  price?: number;
  yes_price?: number;
  no_price?: number;
  client_order_id?: string;
}

/** Order response from API */
export interface KalshiOrder {
  order_id: string;
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  count: number;
  type: OrderType;
  yes_price?: number;
  no_price?: number;
  status: OrderStatus;
  created_time: string;
  updated_time?: string;
  client_order_id?: string;
  remaining_count?: number;
}

/** Fill record */
export interface KalshiFill {
  trade_id: string;
  order_id: string;
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  count: number;
  yes_price?: number;
  no_price?: number;
  created_time: string;
  is_taker: boolean;
}

/** Event from API */
export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  category: string;
  status: string;
  mutually_exclusive: boolean;
  markets: KalshiMarket[];
}

/** Markets list response */
export interface MarketsResponse {
  markets: KalshiMarket[];
  cursor?: string;
}

/** Positions list response */
export interface PositionsResponse {
  market_positions: KalshiPosition[];
  cursor?: string;
}

/** Orders list response */
export interface OrdersResponse {
  orders: KalshiOrder[];
  cursor?: string;
}

/** Fills list response */
export interface FillsResponse {
  fills: KalshiFill[];
  cursor?: string;
}

/** Events list response */
export interface EventsResponse {
  events: KalshiEvent[];
  cursor?: string;
}

/** Exchange status response */
export interface ExchangeStatusResponse {
  exchange_active: boolean;
  trading_active: boolean;
}

/** Query parameters for markets */
export interface MarketsQueryParams {
  status?: 'active' | 'closed' | 'settled';
  limit?: number;
  cursor?: string;
  series_ticker?: string;
  event_ticker?: string;
}

/** Query parameters for positions */
export interface PositionsQueryParams {
  settlement_status?: 'unsettled' | 'settled' | 'all';
  limit?: number;
  cursor?: string;
}

/** Query parameters for orders */
export interface OrdersQueryParams {
  ticker?: string;
  status?: OrderStatus;
  limit?: number;
  cursor?: string;
}

/** Query parameters for fills */
export interface FillsQueryParams {
  ticker?: string;
  order_id?: string;
  min_ts?: number;
  limit?: number;
  cursor?: string;
}

/** Crypto markets filter config */
export interface CryptoMarketsConfig {
  assets?: CryptoAsset[];
  timeframes?: MarketTimeframe[];
}

/** Sports markets filter config */
export interface SportsMarketsConfig {
  leagues?: SportsLeague[];
  maxTimeToSettle?: number;
}

/** API error with status */
export interface KalshiApiError extends Error {
  status: number;
  code?: string;
}

/** WebSocket channel types */
export type WebSocketChannel =
  | 'ticker'
  | 'ticker_v2'
  | 'trade'
  | 'market_lifecycle_v2'
  | 'multivariate'
  | 'orderbook_delta'
  | 'fill'
  | 'market_positions'
  | 'communications'
  | 'order_group_updates';

/** WebSocket message base */
export interface WebSocketMessage {
  id?: number;
  type: string;
  msg?: Record<string, unknown>;
}

/** WebSocket ticker update */
export interface TickerUpdate {
  ticker: string;
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  volume?: number;
}

/** WebSocket trade update */
export interface TradeUpdate {
  ticker: string;
  price: number;
  count: number;
  side: OrderSide;
  taker_side: OrderAction;
  ts: number;
}

/** WebSocket orderbook delta */
export interface OrderbookDelta {
  ticker: string;
  price: number;
  delta: number;
  side: OrderSide;
}

/** WebSocket fill notification */
export interface FillNotification {
  order_id: string;
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  count: number;
  price: number;
  ts: number;
}

/** WebSocket position update */
export interface PositionUpdate {
  ticker: string;
  position: number;
  market_exposure: number;
}
