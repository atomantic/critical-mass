/**
 * Type definitions for configuration and state objects
 */

import { CryptoAsset, MarketTimeframe, SportsLeague, FormattedBalance, KalshiPosition, KalshiOrder, OrderSide } from './kalshi';

/** Crypto market configuration */
export interface CryptoMarketConfig {
  assets: CryptoAsset[];
  timeframes: MarketTimeframe[];
}

/** Sports market configuration */
export interface SportsMarketConfig {
  leagues: SportsLeague[];
  maxTimeToSettle: number;
}

/** Markets configuration section */
export interface MarketsConfig {
  crypto: CryptoMarketConfig;
  sports: SportsMarketConfig;
}

/** Risk limits configuration */
export interface RiskConfig {
  maxPositionContracts: number;
  maxDailyLoss: number;
  maxOpenPositions: number;
  maxSignalsPerEval?: number;
  maxSlippage?: number;
  maxTradeDollars?: number;
}

/** Individual strategy configuration */
export interface StrategyConfig {
  enabled: boolean;
  description?: string;
  params?: Record<string, number | string | boolean>;
}

/** All strategies configuration */
export interface StrategiesConfig {
  [strategyName: string]: StrategyConfig;
}

/** Main application configuration */
export interface AppConfig {
  enabled: boolean;
  dryRun: boolean;
  apiEnvironment: 'demo' | 'prod';
  markets: MarketsConfig;
  risk: RiskConfig;
  strategies: StrategiesConfig;
}

/** Daily statistics */
export interface DailyStats {
  trades: number;
  wins: number;
  pnl: number;
  fees?: number;
}

/** Simulated position for dry run */
export interface SimulatedPosition {
  ticker: string;
  position: number;
  avgPrice: number;
}

/** Simulated order for dry run */
export interface SimulatedOrder {
  order_id: string;
  ticker: string;
  side: OrderSide;
  action: 'buy' | 'sell';
  count: number;
  type: 'limit' | 'market';
  price?: number;
  status: 'filled' | 'pending';
  created_time: string;
}

/** Application state */
export interface AppState {
  engineRunning: boolean;
  mode?: 'live' | 'dry_run';
  balance: FormattedBalance;
  positions: KalshiPosition[] | SimulatedPosition[];
  todayStats: DailyStats;
  trades?: SimulatedOrder[];
  lastUpdated: string;
}

/** Status response combining config and state */
export interface StatusResponse {
  config: {
    enabled: boolean;
    dryRun: boolean;
    apiEnvironment: 'demo' | 'prod';
  };
  balance: FormattedBalance;
  positions: KalshiPosition[] | SimulatedPosition[];
  engineRunning: boolean;
  todayStats: DailyStats;
  lastUpdated: string;
}

/** Engine status response */
export interface EngineStatus {
  running: boolean;
  mode: 'live' | 'dry_run';
  enabled: boolean;
}

/** Order request from client */
export interface OrderRequestBody {
  ticker: string;
  side: OrderSide;
  action: 'buy' | 'sell';
  count: number;
  type?: 'limit' | 'market';
  price?: number;
}

/** Keys update request body */
export interface KeysUpdateBody {
  keyId: string;
  privateKeyPem: string;
  environment?: 'demo' | 'prod';
}

/** Markets query parameters */
export interface MarketsQueryParams {
  type?: 'crypto' | 'sports';
  asset?: CryptoAsset;
  sport?: SportsLeague;
  timeframe?: MarketTimeframe;
  limit?: string;
}

/** Strategy update request */
export interface StrategyUpdateBody {
  enabled?: boolean;
  description?: string;
  params?: Record<string, number | string | boolean>;
}
