// KALLISTI GOLD v1.0 — GOLD FUTURES SWING TRADER
// Last optimized: 2026-02-10 (initial deployment)
//
// EXCHANGE: Coinbase CFM (CFTC-regulated)
//   - Instrument: GLD-27MAR26-CDE (Gold dated futures)
//   - Contract: 1 contract = 1 oz gold ≈ $5,000
//   - Leverage: 10x intraday
//   - Position: $500 × 10x = $5,000 notional ≈ 1 contract
//   - Taker fee: 0.03% per side ($3 round-trip on $5k)
//   - Maker fee: 0% (promotional!)
//
// GOLD CHARACTERISTICS:
//   - Daily range: 0.5-1.2% (vs BTC 2-5%)
//   - Driven by: rates, dollar, geopolitics, safe-haven flows
//   - Trends: cleaner, longer-lasting than BTC
//   - Sessions: London (03:00-12:00 UTC), NY (13:30-20:00 UTC)
//   - Personality: trend-following + mean-reversion to 20/50 EMAs
//
// P&L math at 10x:
//   $5,000 position, 0.03% taker = $1.50/side = $3 round-trip
//   0.10% move = $5 gross → $2 net
//   0.30% move = $15 gross → $12 net
//   0.50% move = $25 gross → $22 net
//   1.00% move = $50 gross → $47 net

export type TradingMode = "paper" | "live";

const env = process.env;

export const config = {
  tradingMode: (env.TRADING_MODE as TradingMode) || "paper",
  symbol: env.TARGET_SYMBOL || "GLD-PERP",
  candleInterval: "1m",
  candleLimit: 30,
  
  dataSource: {
    provider: "coinbase" as "coinbase" | "binance",
    baseUrl: env.DATA_BASE_URL || "https://api.coinbase.com",
    sandboxUrl: "https://api-sandbox.coinbase.com",
  },
  
  auth: {
    keyName: env.COINBASE_CDP_KEY_NAME || "",
    privateKey: env.COINBASE_CDP_PRIVATE_KEY || "",
  },
  
  futures: {
    leverage: 10,
    maxPositions: 1,
    contractSize: 1,  // 1 contract = 1 oz gold (vs BTC 0.01)
  },
  
  fees: {
    takerFeePercent: 0.03,
    makerFeePercent: 0.00,
    feeMode: "taker" as "taker" | "maker",
    minFeePerContract: 0.15,
  },
  
  strategy: {
    // Profit targets — gold moves slower, need patience
    minProfitDollars: 6,
    maxProfitDollars: 150,
    quickGrabDollars: 15,
    
    // Gold-tuned percentages (tighter than BTC — gold is less volatile)
    targetProfitPercent: 1.5,       // 0.50% = $25 gross → $22 net
    initialStopPercent: 0.5,        // 0.30% = -$15 gross → -$18 net
    recoveryStopPercent: 0.4,
    
    // Hold times — gold trends are cleaner, hold longer
    maxTradeSeconds: 7200,           // 2 hour max hold
    quickExitSeconds: 600,           // 5 min quick grab
    recoveryTimeSeconds: 300,
    underwaterCutSeconds: 3600,       // 15 min underwater cut
    underwaterMinLoss: -20,          // Cut at -$15 net
    
    // Momentum detection — gold needs lower thresholds (less volatile)
    consecutiveCandles: 2,
    momentumThreshold: 0.03,         // Gold 1m candles are smaller
    maxChasePercent: 0.35,           // Tighter chase for gold
    
    volumeMultiplier: 1.0,
    volumeLookback: 10,
    
    minVolatilityPercent: 0.002,      // Lower bar — gold is inherently less volatile
    
    // Mean reversion — gold loves mean reversion to EMAs
    meanReversionEnabled: true,
    mrThresholdPercent: 0.12,        // Fade moves > 0.20% in lookback
    mrMaxThresholdPercent: 0.60,     // Don't fade > 0.60% (real breakout)
    mrTargetPercent: 0.2,           // Target 0.15% reversion
    mrStopPercent: 0.3,             // Stop 0.12%
    mrLookbackCandles: 15,
    mrMinCandlesInDirection: 4,
  },
  
  risk: {
    initialBalance: 2000,
    positionSizeDollars: 500,
    riskPerTrade: 500,
    maxDailyLossPercent: 10,
    maxDailyLossDollars: 150,
    maxConsecutiveLosses: 4,
    pauseAfterLossesMinutes: 30,
    maxTradesPerHour: 10,
    maxOpenRiskDollars: 500,
  },
  
  ledgerPath: "./data/ledger.json",
};
