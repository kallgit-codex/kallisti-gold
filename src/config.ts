// Last optimized: 2026-02-10T16:32:44.334Z
// Reason: Switch to mean-reversion primary in chop regime, widen stops/targets for high-vol, lower ATR filter so bot actually trades, reduce trade frequency to 2/hr, longer hold times
// was overriding config volumeMultiplier=1.0, inflating threshold to 0.25%. Also adding
// mean-reversion mode for high_vol_chop regime. Wider targets for high-vol environment.
// KALLISTI SCALPER v5.0 - DUAL MODE (Momentum + Mean Reversion)
//
// KEY CHANGES v5.0:
//   - Fixed vol multiplier (code now uses config value)
//   - Added mean reversion parameters
//   - Wider profit targets for high-vol
//   - Extended flat-cut to 90s
//   - Maker fee mode for entries (0% fee!)
//
// EXCHANGE: Coinbase CFM (CFTC-regulated)
//   - Leverage: 10x intraday
//   - Position: $500 × 10x = $5,000 notional
//   - Taker fee: 0.03% per side ($3 round-trip)
//   - Maker fee: 0% (promotional!)
//   - Contracts: 0.01 BTC each
//
// P&L math at 10x (taker both sides):
//   $5,000 position, 0.03% taker = $1.50/side = $3 round-trip
//   0.10% move = $5 gross → $2 net
//   0.20% move = $10 gross → $7 net
//   0.50% move = $25 gross → $22 net

export type TradingMode = "paper" | "live";

const env = process.env;

export const config = {
  tradingMode: (env.TRADING_MODE as TradingMode) || "paper",
  symbol: env.TARGET_SYMBOL || "BTC-PERP",
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
    contractSize: 0.01,
  },
  
  fees: {
    takerFeePercent: 0.03,
    makerFeePercent: 0.00,
    feeMode: "taker" as "taker" | "maker",
    minFeePerContract: 0.15,
  },
  
  strategy: {
    // Profit targets (NET after fees)
    minProfitDollars: 8,            // $8 net = ~0.22% move
    maxProfitDollars: 200,           // $50 net = ~1.06% move
    quickGrabDollars: 10,            // $4 net = ~0.14% move (achievable in high vol)
    
    targetProfitPercent: 1.2,      // 0.20% gross = $10 → $7 net
    initialStopPercent: 0.65,       // 0.15% gross = -$7.50 → -$10.50 net
    recoveryStopPercent: 0.04,
    
    maxTradeSeconds: 3600,           // 4 min max hold
    quickExitSeconds: 300,           // 20s quick grab
    recoveryTimeSeconds: 120,
    underwaterCutSeconds: 600,      // Cut losing trades at 2.5 min
    underwaterMinLoss: -25,          // Cut at -$8 net
    
    // Momentum detection
    consecutiveCandles: 4,
    momentumThreshold: 0.12,        // Base threshold before vol adjustment
    maxChasePercent: 0.3,          // Allow slightly more chase in high vol
    
    // CRITICAL: This is now actually used by the strategy code
    volumeMultiplier: 1.2,          // Vol-adjusted threshold = avgRange * 1.5
    volumeLookback: 10,
    
    minVolatilityPercent: 0.08,
    
    // Mean reversion parameters (NEW in v5.0)
    meanReversionEnabled: true,
    mrThresholdPercent: 0.3,       // Fade moves > 0.30% in 5 candles
    mrMaxThresholdPercent: 1,    // Don't fade moves > 0.80% (could be breakout)
    mrTargetPercent: 0.4,          // Target 0.12% reversion = $6 gross
    mrStopPercent: 0.25,            // Stop 0.18% = -$9 gross
    mrLookbackCandles: 10,           // Measure move over 5 candles
    mrMinCandlesInDirection: 5,     // At least 3 of 5 candles in same direction
  },
  
  risk: {
    initialBalance: 2000,
    positionSizeDollars: 500,
    riskPerTrade: 500,
    maxDailyLossPercent: 10,
    maxDailyLossDollars: 150,
    maxConsecutiveLosses: 3,        // More lenient
    pauseAfterLossesMinutes: 60,    // Shorter pause
    maxTradesPerHour: 2,            // Allow more trades
    maxOpenRiskDollars: 500,
  },
  
  ledgerPath: "./data/ledger.json",
};
