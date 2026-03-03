# Unreleased Changes

## Added

- Weekly (1w) candle timeframe — derived from 1d candles, served via API, rendered as full-width macro chart banner on UpDown dashboard
- OBV (On-Balance Volume) indicator — volume-confirmed trend direction scoring at 13% weight
- ADX (Average Directional Index) indicator — Wilder's method with +DI/-DI, trend/range regime classification
- Weekly macro trend filter — EMA(4)/EMA(8) on 1w candles with 60% counter-weekly dampening
- ADX regime modulation — +15% composite boost in trending markets, -20% in ranging markets
- ADX dynamic weight shift — reallocates 15% weight between trend-following (MACD/Momentum) and mean-reversion (RSI/Bollinger) indicators based on regime

## Changed

- `npm start` now deletes and restarts all PM2 processes then saves, replacing the old direct `node server.js` invocation

## Fixed

## Removed
