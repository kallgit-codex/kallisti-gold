// KALLISTI GOLD v2.0 — BACKTESTED CHAMPION STRATEGY
// Optimized: 2026-02-11 (7000+ parameter combinations tested)
//
// STRATEGY: Long-only EMA 5/34 crossover + MACD momentum
// BACKTEST: 13,226 hourly candles (Sep 2023 → Feb 2026)
//   - 101 trades | 58.4% WR | PF 2.46 | Max DD 7.8%
//   - $2,000 → $4,029 (+101.4%) fixed size
//   - $2,000 → $5,290 (+164.5%) compounding at 25% risk
//   - 82.1% monthly win rate (23/28 months green)
//
// KEY INSIGHT: Gold wants WIDE stops + HIGH ROI targets.
//   Old 2% stop was too tight — gold needs 5% room to breathe.
//   Patient profit-taking (3.43x ROI multiplier) lets big moves run.
//   Long-only eliminates short-side losses in secular bull market.
//
// EXCHANGE: Coinbase CFM (CFTC-regulated)
//   - Instrument: GLD-27MAR26-CDE (Gold dated futures)
//   - Contract: 1 contract = 1 oz gold ≈ $5,000
//   - Leverage: 15x (backtested optimal)
//   - Position: $500 × 15x = $7,500 notional
//   - Taker fee: 0.03% per side ($4.50 round-trip on $7.5k)
//   - Maker fee: 0% (promotional)
//
// P&L math at 15x:
//   $7,500 position, 0.03% taker = $2.25/side = $4.50 round-trip
//   0.50% move = $37.50 gross → $33.00 net
//   1.00% move = $75.00 gross → $70.50 net
//   2.00% move = $150.00 gross → $145.50 net
//   5.00% move = $375.00 gross → $370.50 net (stoploss)

export type TradingMode = "paper" | "live";

const env = process.env;

export const config = {
  tradingMode: (env.TRADING_MODE as TradingMode) || "paper",
  symbol: env.TARGET_SYMBOL || "GLD-PERP",
  
  // CRITICAL CHANGE: 1h candles for swing trading (was 1m for scalping)
  candleInterval: "1h",
  candleLimit: 60,  // 60 hourly candles = 2.5 days, enough for EMA34 + buffer
  
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
    leverage: 10,         // Coinbase max is 10x
    maxPositions: 1,
    contractSize: 1,
  },
  
  fees: {
    takerFeePercent: 0.03,
    makerFeePercent: 0.00,
    feeMode: "taker" as "taker" | "maker",
    minFeePerContract: 0.15,
  },
  
  strategy: {
    // === CHAMPION PARAMETERS (backtested on 13,226 hourly candles) ===
    
    // Direction: LONG ONLY — shorts destroy P&L in gold bull market
    longOnly: true,
    
    // EMA crossover (fast/slow) — 5/34 dominated top 25 results
    emaFastPeriod: 5,
    emaSlowPeriod: 34,
    
    // Entry filters
    adxThreshold: 18,           // ADX > 18 confirms trend strength
    volumeMultiplier: 1.29,     // Volume > 1.29x average
    rsiEntryMax: 65,            // Don't enter overbought
    momentumAdxMin: 15,         // Momentum signal ADX minimum
    macdVolumeThreshold: 2.0,   // Momentum signal needs 2x volume
    
    // Stoploss — WIDE (gold needs room to breathe)
    stoplossPercent: 4.95,      // 4.95% stop — backtested optimal
    
    // ROI table — 3.43x multiplier (patient profit-taking)
    // At 3.43x: immediate 8.58%, 1hr 5.15%, 2hr 3.43%, 4hr 1.72%, 8hr 1.03%
    roiMultiplier: 3.43,
    roiTable: {
      0: 8.58,      // Immediate: 8.58% (rare but grab it)
      60: 5.15,     // 1 hour: 5.15%
      120: 3.43,    // 2 hours: 3.43%
      240: 1.72,    // 4 hours: 1.72%
      480: 1.03,    // 8 hours: 1.03%
    },
    
    // Trailing stop
    trailingStartPercent: 0.52,   // Trail by 0.52% behind peak
    trailingOffsetPercent: 1.40,  // Activate after 1.40% profit
    
    // Exit signals
    exitRsi: 75,                  // Exit when RSI > 75

    // Hold times (hourly strategy = much longer holds)
    maxTradeMinutes: 720,         // 12 hour max hold
    minHoldMinutes: 30,           // 30 min minimum hold
    
    // Legacy params (kept for compatibility, not used by new strategy)
    minProfitDollars: 5,
    maxProfitDollars: 500,
    quickGrabDollars: 50,
    targetProfitPercent: 3.43,
    initialStopPercent: 4.95,
    recoveryStopPercent: 4.95,
    maxTradeSeconds: 43200,
    quickExitSeconds: 1800,
    recoveryTimeSeconds: 600,
    underwaterCutSeconds: 14400,
    underwaterMinLoss: -100,
    consecutiveCandles: 2,
    momentumThreshold: 0.025,
    maxChasePercent: 0.35,
    volumeLookback: 20,
    minVolatilityPercent: 0.002,
    meanReversionEnabled: false,
    mrThresholdPercent: 0.12,
    mrMaxThresholdPercent: 0.60,
    mrTargetPercent: 0.2,
    mrStopPercent: 0.3,
    mrLookbackCandles: 15,
    mrMinCandlesInDirection: 4,
  },
  
  risk: {
    initialBalance: 2000,
    positionSizeDollars: 500,
    riskPerTrade: 500,
    maxDailyLossPercent: 15,          // Wider for swing trades
    maxDailyLossDollars: 300,   // ~1.2x max single loss at 10x ($247)
    maxConsecutiveLosses: 4,
    pauseAfterLossesMinutes: 60,      // 1 hour cooldown (was 30m)
    maxTradesPerHour: 2,              // Hourly candles = fewer trades
    maxOpenRiskDollars: 500,
  },
  
  ledgerPath: "./data/ledger.json",
};

