// KALLISTI GOLD v1.0 — SWING TRADER
//
// Gold Futures on Coinbase CFM
// Contract: 1 GLD = 1 troy oz gold (~$5,031)
//
// EXCHANGE: Coinbase CFM (CFTC-regulated)
//   - Leverage: 10x intraday
//   - Position: 1 contract = ~$5,031 notional ($503 margin)
//   - Taker fee: 0.03% per side (~$1.51/side = $3.02 round-trip)
//   - Maker fee: 0% (promotional!)
//
// GOLD CHARACTERISTICS:
//   - Daily range: 0.5-1.0% (~$25-50 per contract)
//   - Cleaner trends than BTC, longer holds rewarded
//   - Driven by: USD strength, rates, geopolitics
//   - Best sessions: London open (3am ET), NY open (8:30am ET)
//
// P&L math at 10x (1 contract, taker both sides):
//   0.25% move = $12.58 gross → $9.56 net
//   0.50% move = $25.16 gross → $22.14 net
//   1.00% move = $50.31 gross → $47.29 net

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
    contractSize: 1,       // 1 contract = 1 troy oz gold
  },
  
  fees: {
    takerFeePercent: 0.03,
    makerFeePercent: 0.00,
    feeMode: "taker" as "taker" | "maker",
    minFeePerContract: 0.15,
  },
  
  strategy: {
    // Profit targets — gold has cleaner moves, hold longer
    minProfitDollars: 8,             // ~0.16% move net
    maxProfitDollars: 150,           // ~3% move (big gold day)
    quickGrabDollars: 6,             // ~0.12% quick scalp
    
    targetProfitPercent: 0.8,        // Gold trends = let it run
    initialStopPercent: 0.4,         // Wider stop for gold's noise
    recoveryStopPercent: 0.04,
    
    maxTradeSeconds: 7200,           // 2 hour max hold (gold trends last)
    quickExitSeconds: 300,           // 5 min quick grab window
    recoveryTimeSeconds: 120,
    underwaterCutSeconds: 900,       // 15 min underwater cut
    underwaterMinLoss: -20,          // Cut at -$20 net
    
    // Momentum detection — gold needs less sensitivity
    consecutiveCandles: 3,
    momentumThreshold: 0.08,         // Gold moves slower than BTC
    maxChasePercent: 0.25,           // Don't chase too far
    
    volumeMultiplier: 1.0,
    volumeLookback: 10,
    
    minVolatilityPercent: 0.05,      // Gold can trade on smaller vol
    
    // Mean reversion — gold mean-reverts well to 20/50 EMAs
    meanReversionEnabled: true,
    mrThresholdPercent: 0.25,        // Fade moves > 0.25%
    mrMaxThresholdPercent: 0.8,
    mrTargetPercent: 0.3,
    mrStopPercent: 0.2,
    mrLookbackCandles: 10,
    mrMinCandlesInDirection: 4,
  },
  
  risk: {
    initialBalance: 2000,
    positionSizeDollars: 500,        // ~1 contract at 10x
    riskPerTrade: 500,
    maxDailyLossPercent: 10,
    maxDailyLossDollars: 150,
    maxConsecutiveLosses: 3,
    pauseAfterLossesMinutes: 60,
    maxTradesPerHour: 2,
    maxOpenRiskDollars: 500,
  },
  
  ledgerPath: "./data/ledger.json",
};
