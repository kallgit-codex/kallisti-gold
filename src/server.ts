// Railway Deployment - Continuous Trading Loop v7.0
// KALLISTI SWING TRADER - Conservative Long-Biased + Trailing Stops
// 
// v7.0 Changes:
//   - CRASH FIX: Removed call to non-existent ledger.checkDailyReset()
//   - Daily reset logic handled inline in scan()
//   - Long-biased: 100% WR on longs, 0% on shorts — heavily favor longs
//   - Shorts only on extremely high-confidence setups
//   - Validated swing approach: 30-60 min holds targeting 1%+ moves
//   - Death cross awareness: conservative entries, wait for dips
//   - Improved trailing stop system with ATR-adaptive distances
//   - Better position status logging
//   - Safer ledger property access throughout

import { config } from "./config";
import { log, error } from "./logger";
import { CoinbaseClient } from "./exchange/coinbase";
import { CoinbaseTrader } from "./exchange/coinbase-trade";
import { BinanceClient } from "./exchange/binance";
import { detectMomentum, Candle } from "./strategy/momentum-strategy";
import { createPosition, updatePosition } from "./risk/recovery-manager";
import { Ledger } from "./ledger";
import { GitHubSync } from "./github-sync";
import { getOverrides, getCurrentBrief, ScalperOverrides } from "./brief-reader";

const SCAN_INTERVAL_MS = 30_000;
const GITHUB_SYNC_INTERVAL_MS = 300_000;

let lastSignalTime = 0;
const MIN_SIGNAL_INTERVAL = 90_000; // 90s between signals — swing trader patience
let lastLossTime = 0;
const POST_LOSS_COOLDOWN_MS = 300_000; // 5 min cooldown after loss (was 3)
let scanCount = 0;
let lastGitHubSync = 0;
let isRunning = true;
let currentOverrides: ScalperOverrides | null = null;
let lastOptimizerTrigger = 0;
const OPTIMIZER_COOLDOWN_MS = 600_000;

// Trailing stop state
interface TrailingState {
  positionId: string;
  highWaterMark: number;
  stopMovedToBreakeven: boolean;
  trailingStopPrice: number | null;
  entryTime: number;
}
const trailingStops: Map<string, TrailingState> = new Map();

// Hard limits
const ABSOLUTE_MAX_HOLD_SECONDS = 3600; // 60 min absolute max
const ABSOLUTE_MAX_LOSS_DOLLARS = 30;   // $30 max loss per trade
const BREAKEVEN_TRIGGER_PERCENT = 0.4;  // Move stop to breakeven after 0.4% profit
const TRAILING_DISTANCE_PERCENT = 0.25; // Trail 0.25% behind peak (tighter to lock in gains)

let coinbaseClient: CoinbaseClient | null = null;
let coinbaseTrader: CoinbaseTrader | null = null;
let binanceFallback: BinanceClient | null = null;

async function triggerOptimizer(reason: string): Promise<void> {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
  if (!GITHUB_TOKEN) return;
  try {
    const resp = await fetch(
      "https://api.github.com/repos/kallgit-codex/kallisti-scalper/actions/workflows/optimizer.yml/dispatches",
      {
        method: "POST",
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      }
    );
    if (resp.ok || resp.status === 204) {
      log("🧠 Triggered optimizer — " + reason);
    } else {
      error("❌ Optimizer trigger failed: " + resp.status);
    }
  } catch (err) {
    error("❌ Optimizer trigger error: " + err);
  }
}

function safeParseFloat(val: any): number {
  if (val === undefined || val === null) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "string") return parseFloat(val) || 0;
  return 0;
}

function normalizeCandles(rawKlines: any[]): Candle[] {
  if (!rawKlines || !Array.isArray(rawKlines)) return [];
  return rawKlines
    .filter((k: any) => k !== null && k !== undefined)
    .map((k: any) => {
      if (Array.isArray(k)) {
        return {
          time: typeof k[0] === "number" ? k[0] : parseInt(String(k[0] || "0")),
          open: safeParseFloat(k[1]),
          high: safeParseFloat(k[2]),
          low: safeParseFloat(k[3]),
          close: safeParseFloat(k[4]),
          volume: safeParseFloat(k[5]),
        };
      }
      return {
        time: safeParseFloat(k.start || k.time || k.timestamp || 0),
        open: safeParseFloat(k.open),
        high: safeParseFloat(k.high),
        low: safeParseFloat(k.low),
        close: safeParseFloat(k.close),
        volume: safeParseFloat(k.volume),
      };
    })
    .filter((c: Candle) => c.close > 0);
}

async function fetchCoinbaseCandles(): Promise<Candle[] | null> {
  if (!coinbaseClient) return null;
  try {
    const result = await coinbaseClient.getKlines(
      config.symbol,
      config.candleInterval,
      config.candleLimit
    );
    if (!result) {
      error("Coinbase candle fetch: null result");
      return null;
    }
    const list = result.list || result;
    if (!list || !Array.isArray(list) || list.length === 0) {
      error("Coinbase candle fetch: empty or invalid list");
      return null;
    }
    const firstItem = list[0];
    if (firstItem === undefined || firstItem === null) {
      error("Coinbase candle fetch: first element is null/undefined");
      return null;
    }
    const candles = normalizeCandles(list);
    if (candles.length === 0) {
      error("Coinbase candle fetch: normalization produced 0 valid candles");
      return null;
    }
    return candles;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error("Coinbase candle fetch failed: " + msg);
    return null;
  }
}

async function fetchCandles(): Promise<Candle[]> {
  const cbCandles = await fetchCoinbaseCandles();
  if (cbCandles && cbCandles.length > 0) {
    return cbCandles;
  }
  
  if (scanCount % 20 === 1) {
    log("⚠️ Using Binance public API for market data");
  }
  
  if (!binanceFallback) {
    binanceFallback = new BinanceClient("https://data-api.binance.vision");
  }
  
  try {
    const klines = await binanceFallback.getKlines("BTCUSDT", config.candleInterval, config.candleLimit);
    if (!klines || !klines.list) return [];
    return normalizeCandles(klines.list);
  } catch (err) {
    error("Binance candle fetch also failed: " + (err instanceof Error ? err.message : String(err)));
    return [];
  }
}

// ===== SWING TRADING ANALYTICS =====

interface SwingAnalysis {
  trend: "bullish" | "bearish" | "neutral";
  trendStrength: number;
  ema20: number;
  ema50: number;
  atrPercent: number;
  priceVsEma20Pct: number;
  priceVsEma50Pct: number;
  isPullbackToEma: boolean;
  deathCross: boolean;
  goldenCross: boolean;
  recentHigh: number;
  recentLow: number;
  rangePercent: number;
  momentumScore: number;
  rsi14: number;
  isNearSupport: boolean;
  isNearResistance: boolean;
}

function calculateEMA(values: number[], period: number): number[] {
  const ema: number[] = [];
  if (values.length === 0) return ema;
  const multiplier = 2 / (period + 1);
  ema[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    ema[i] = (values[i] - ema[i - 1]) * multiplier + ema[i - 1];
  }
  return ema;
}

function calculateRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  // Initial average
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function analyzeSwing(candles: Candle[]): SwingAnalysis | null {
  if (candles.length < 20) return null;
  
  const closes = candles.map(c => c.close);
  const ema20Arr = calculateEMA(closes, 20);
  const ema50Arr = calculateEMA(closes, Math.min(50, candles.length));
  
  const currentPrice = closes[closes.length - 1];
  const ema20 = ema20Arr[ema20Arr.length - 1];
  const ema50 = ema50Arr[ema50Arr.length - 1];
  
  const priceVsEma20Pct = ((currentPrice - ema20) / ema20) * 100;
  const priceVsEma50Pct = ((currentPrice - ema50) / ema50) * 100;
  
  // ATR calculation
  const atrPeriod = Math.min(14, candles.length - 1);
  let atrSum = 0;
  for (let i = candles.length - atrPeriod; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    atrSum += tr;
  }
  const atr = atrSum / atrPeriod;
  const atrPercent = (atr / currentPrice) * 100;
  
  // Recent range
  const recentCandles = candles.slice(-24);
  const recentHigh = Math.max(...recentCandles.map(c => c.high));
  const recentLow = Math.min(...recentCandles.map(c => c.low));
  const rangePercent = ((recentHigh - recentLow) / recentLow) * 100;
  
  // Trend
  const deathCross = ema20 < ema50;
  const goldenCross = ema20 > ema50;
  
  // Momentum score
  const last10 = candles.slice(-10);
  const ema20Last10 = ema20Arr.slice(-10);
  let aboveCount = 0;
  let belowCount = 0;
  for (let i = 0; i < last10.length; i++) {
    if (last10[i].close > ema20Last10[i]) aboveCount++;
    else belowCount++;
  }
  const momentumScore = (aboveCount - belowCount) / 10;
  
  // RSI
  const rsi14 = calculateRSI(closes, 14);
  
  let trend: "bullish" | "bearish" | "neutral" = "neutral";
  let trendStrength = 0;
  
  if (goldenCross && priceVsEma20Pct > 0) {
    trend = "bullish";
    trendStrength = Math.min(1, Math.abs(priceVsEma20Pct) / 2 + Math.abs(momentumScore));
  } else if (deathCross && priceVsEma20Pct < 0) {
    trend = "bearish";
    trendStrength = Math.min(1, Math.abs(priceVsEma20Pct) / 2 + Math.abs(momentumScore));
  } else {
    trend = priceVsEma20Pct > 0.1 ? "bullish" : priceVsEma20Pct < -0.1 ? "bearish" : "neutral";
    trendStrength = Math.min(1, Math.abs(priceVsEma20Pct) / 3);
  }
  
  // Pullback detection
  let isPullbackToEma = false;
  const last5 = candles.slice(-5);
  const ema20Last5 = ema20Arr.slice(-5);
  for (let i = 0; i < last5.length; i++) {
    const distPct = Math.abs((last5[i].close - ema20Last5[i]) / ema20Last5[i]) * 100;
    if (distPct < 0.15) {
      isPullbackToEma = true;
      break;
    }
  }
  
  // Support/Resistance detection
  const distToLow = ((currentPrice - recentLow) / recentLow) * 100;
  const distToHigh = ((recentHigh - currentPrice) / currentPrice) * 100;
  const isNearSupport = distToLow < atrPercent * 1.5;
  const isNearResistance = distToHigh < atrPercent * 1.5;
  
  return {
    trend,
    trendStrength,
    ema20,
    ema50,
    atrPercent,
    priceVsEma20Pct,
    priceVsEma50Pct,
    isPullbackToEma,
    deathCross,
    goldenCross,
    recentHigh,
    recentLow,
    rangePercent,
    momentumScore,
    rsi14,
    isNearSupport,
    isNearResistance,
  };
}

// ===== TRAILING STOP MANAGEMENT =====

interface TrailingStopResult {
  shouldClose: boolean;
  reason: string;
  exitPrice: number;
}

function manageTrailingStop(
  position: any,
  currentPrice: number,
  state: TrailingState,
  atrPercent: number
): TrailingStopResult {
  const isLong = position.side === "Long";
  const entryPrice = position.entryPrice;
  const leverage = position.leverage || config.futures.leverage;
  const notional = (position.collateral || config.risk.positionSizeDollars) * leverage;
  
  const priceMovePct = isLong
    ? ((currentPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - currentPrice) / entryPrice) * 100;
  const unrealizedPnl = (priceMovePct / 100) * notional;
  
  const holdSeconds = (Date.now() - state.entryTime) / 1000;
  
  // === HARD CIRCUIT BREAKER ===
  if (holdSeconds >= ABSOLUTE_MAX_HOLD_SECONDS) {
    return {
      shouldClose: true,
      reason: `⏰ HARD LIMIT: ${Math.round(holdSeconds)}s exceeds ${ABSOLUTE_MAX_HOLD_SECONDS}s max`,
      exitPrice: currentPrice,
    };
  }
  
  // === ABSOLUTE DOLLAR LOSS CAP ===
  if (unrealizedPnl <= -ABSOLUTE_MAX_LOSS_DOLLARS) {
    return {
      shouldClose: true,
      reason: `🛑 LOSS CAP: $${unrealizedPnl.toFixed(2)} exceeds -$${ABSOLUTE_MAX_LOSS_DOLLARS} limit`,
      exitPrice: currentPrice,
    };
  }
  
  // Update high water mark
  if (unrealizedPnl > state.highWaterMark) {
    state.highWaterMark = unrealizedPnl;
  }
  
  // === BREAKEVEN STOP ===
  if (!state.stopMovedToBreakeven && priceMovePct >= BREAKEVEN_TRIGGER_PERCENT) {
    state.stopMovedToBreakeven = true;
    // Set breakeven slightly above entry to cover fees (~$3 round trip)
    const feeBuffer = isLong ? entryPrice * 0.0006 : -entryPrice * 0.0006; // ~0.06% buffer
    state.trailingStopPrice = entryPrice + feeBuffer;
    log(`📐 Trailing: moved stop to BREAKEVEN+fees @ $${state.trailingStopPrice.toFixed(2)} (profit: ${priceMovePct.toFixed(2)}%)`);
  }
  
  // === ADAPTIVE TRAILING STOP ===
  if (state.stopMovedToBreakeven) {
    // Use ATR-adaptive trail distance: wider in high vol, tighter in low vol
    const adaptiveTrailPct = Math.max(0.15, Math.min(0.4, atrPercent * 0.4));
    const trailDistance = currentPrice * (adaptiveTrailPct / 100);
    const newTrailingStop = isLong
      ? currentPrice - trailDistance
      : currentPrice + trailDistance;
    
    if (state.trailingStopPrice !== null) {
      if (isLong && newTrailingStop > state.trailingStopPrice) {
        state.trailingStopPrice = newTrailingStop;
      } else if (!isLong && newTrailingStop < state.trailingStopPrice) {
        state.trailingStopPrice = newTrailingStop;
      }
    }
    
    // Check if trailing stop hit
    if (state.trailingStopPrice !== null) {
      if (isLong && currentPrice <= state.trailingStopPrice) {
        return {
          shouldClose: true,
          reason: `📐 TRAILING STOP hit @ $${currentPrice.toFixed(2)} (stop: $${state.trailingStopPrice.toFixed(2)}, peak P&L: $${state.highWaterMark.toFixed(2)})`,
          exitPrice: currentPrice,
        };
      }
      if (!isLong && currentPrice >= state.trailingStopPrice) {
        return {
          shouldClose: true,
          reason: `📐 TRAILING STOP hit @ $${currentPrice.toFixed(2)} (stop: $${state.trailingStopPrice.toFixed(2)}, peak P&L: $${state.highWaterMark.toFixed(2)})`,
          exitPrice: currentPrice,
        };
      }
    }
  }
  
  // === TIME-BASED PROFIT TAKING ===
  // After 20 min with > 0.5% profit, start taking
  if (holdSeconds > 1200 && priceMovePct > 0.5) {
    return {
      shouldClose: true,
      reason: `⏱️ TIME PROFIT: ${priceMovePct.toFixed(2)}% after ${Math.round(holdSeconds / 60)}min`,
      exitPrice: currentPrice,
    };
  }
  
  // After 40 min, take any decent profit
  if (holdSeconds > 2400 && priceMovePct > 0.15) {
    return {
      shouldClose: true,
      reason: `⏱️ LATE PROFIT: ${priceMovePct.toFixed(2)}% after ${Math.round(holdSeconds / 60)}min`,
      exitPrice: currentPrice,
    };
  }
  
  // === UNDERWATER CUT: Losing after 15 min ===
  if (holdSeconds > 900 && unrealizedPnl < -8) {
    return {
      shouldClose: true,
      reason: `🔻 UNDERWATER CUT: $${unrealizedPnl.toFixed(2)} after ${Math.round(holdSeconds / 60)}min`,
      exitPrice: currentPrice,
    };
  }
  
  return { shouldClose: false, reason: "", exitPrice: currentPrice };
}

// ===== SWING ENTRY LOGIC =====

interface SwingSignal {
  detected: boolean;
  side: "Long" | "Short";
  reason: string;
  confidence: number;
  mode: "trend_follow" | "pullback" | "bounce" | "momentum";
}

function detectSwingEntry(
  candles: Candle[],
  analysis: SwingAnalysis,
  overrides: ScalperOverrides
): SwingSignal {
  const noSignal: SwingSignal = { detected: false, side: "Long", reason: "", confidence: 0, mode: "trend_follow" };
  const currentPrice = candles[candles.length - 1].close;
  
  // Need minimum volatility
  if (analysis.atrPercent < 0.25) {
    return { ...noSignal, reason: `Low ATR: ${analysis.atrPercent.toFixed(2)}% (need 0.25%)` };
  }
  
  // === STRATEGY 1: LONG BIAS — BUY DIPS TO SUPPORT ===
  // Performance data shows longs are 100% WR. Favor buying dips.
  // Look for price near recent lows / support with RSI oversold
  if (analysis.isNearSupport && analysis.rsi14 < 40) {
    // Near support with oversold RSI — strong long signal
    const confidence = 0.65 + (40 - analysis.rsi14) / 100; // Higher confidence with lower RSI
    return {
      detected: true,
      side: "Long",
      reason: `🟢 SUPPORT BOUNCE: Price near support ($${analysis.recentLow.toFixed(0)}), RSI ${analysis.rsi14.toFixed(1)}, ATR ${analysis.atrPercent.toFixed(2)}%`,
      confidence: Math.min(0.9, confidence),
      mode: "bounce",
    };
  }
  
  // === STRATEGY 2: PULLBACK LONG IN ANY TREND ===
  // Even in death cross, buy pullbacks to EMA20 with bullish reversal candles
  if (analysis.isPullbackToEma && analysis.rsi14 < 45) {
    // Check last candle is bullish (close > open) — reversal candle at EMA
    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];
    const isBullishCandle = lastCandle.close > lastCandle.open;
    const wasBearish = prevCandle.close < prevCandle.open;
    
    if (isBullishCandle && wasBearish) {
      // Bullish reversal candle at EMA20 — good long setup
      return {
        detected: true,
        side: "Long",
        reason: `📈 EMA BOUNCE LONG: Bullish reversal at EMA20 ($${analysis.ema20.toFixed(0)}), RSI ${analysis.rsi14.toFixed(1)}`,
        confidence: 0.6,
        mode: "pullback",
      };
    }
    
    if (isBullishCandle) {
      return {
        detected: true,
        side: "Long",
        reason: `📈 PULLBACK LONG: Price at EMA20 ($${analysis.ema20.toFixed(0)}), bullish candle, RSI ${analysis.rsi14.toFixed(1)}`,
        confidence: 0.5,
        mode: "pullback",
      };
    }
  }
  
  // === STRATEGY 3: GOLDEN CROSS TREND FOLLOW (LONG ONLY) ===
  if (analysis.goldenCross && analysis.trend === "bullish" && analysis.momentumScore > 0.4) {
    const maxChaseFromEma = analysis.atrPercent * 1.2;
    if (analysis.priceVsEma20Pct > 0 && analysis.priceVsEma20Pct < maxChaseFromEma) {
      return {
        detected: true,
        side: "Long",
        reason: `📈 TREND LONG: Golden cross, momentum ${analysis.momentumScore.toFixed(2)}, RSI ${analysis.rsi14.toFixed(1)}`,
        confidence: 0.6 + analysis.trendStrength * 0.2,
        mode: "trend_follow",
      };
    }
  }
  
  // === STRATEGY 4: SHORT ONLY ON EXTREME CONDITIONS ===
  // Shorts have 0% WR — only take them on extreme overbought + strong downtrend
  if (analysis.deathCross && analysis.trend === "bearish" && analysis.trendStrength > 0.7 &&
      analysis.rsi14 > 65 && analysis.isNearResistance && analysis.momentumScore < -0.5) {
    return {
      detected: true,
      side: "Short",
      reason: `📉 EXTREME SHORT: Death cross + RSI ${analysis.rsi14.toFixed(1)} + near resistance + strong bearish momentum`,
      confidence: 0.55, // Lower confidence since shorts have poor track record
      mode: "trend_follow",
    };
  }
  
  // === STRATEGY 5: RSI OVERSOLD BOUNCE ===
  // RSI < 30 is historically a strong mean reversion signal for longs
  if (analysis.rsi14 < 30) {
    return {
      detected: true,
      side: "Long",
      reason: `🟢 RSI OVERSOLD: RSI ${analysis.rsi14.toFixed(1)} — mean reversion long`,
      confidence: 0.7,
      mode: "bounce",
    };
  }
  
  // No signal
  const reason = `Waiting: trend=${analysis.trend}(${analysis.trendStrength.toFixed(2)}) RSI=${analysis.rsi14.toFixed(1)} price ${analysis.priceVsEma20Pct.toFixed(2)}% from EMA20 | support:${analysis.isNearSupport} res:${analysis.isNearResistance}`;
  return { ...noSignal, reason };
}

// ===== SAFE LEDGER ACCESSORS =====
// These helpers safely access ledger properties regardless of internal structure

function getLedgerBalance(ledger: Ledger): number {
  try {
    if (ledger.state && typeof ledger.state.balance === "number") return ledger.state.balance;
    if ((ledger as any).data && typeof (ledger as any).data.balance === "number") return (ledger as any).data.balance;
    return config.risk.initialBalance;
  } catch { return config.risk.initialBalance; }
}

function getLedgerStats(ledger: Ledger): { dailyPnl: number; totalTrades: number; wins: number; losses: number; winRate: string } {
  try {
    const stats = ledger.stats;
    return {
      dailyPnl: stats?.dailyPnl ?? 0,
      totalTrades: stats?.totalTrades ?? 0,
      wins: stats?.wins ?? 0,
      losses: stats?.losses ?? 0,
      winRate: stats?.winRate ?? "0",
    };
  } catch {
    return { dailyPnl: 0, totalTrades: 0, wins: 0, losses: 0, winRate: "0" };
  }
}

function getLedgerOpenPositions(ledger: Ledger): any[] {
  try {
    if (ledger.openPositions && Array.isArray(ledger.openPositions)) return ledger.openPositions;
    if (ledger.state?.positions) return ledger.state.positions.filter((p: any) => p.status === "open");
    if ((ledger as any).data?.positions) return (ledger as any).data.positions.filter((p: any) => p.status === "open");
    return [];
  } catch { return []; }
}

function getLedgerConsecutiveLosses(ledger: Ledger): number {
  try {
    return ledger.state?.consecutiveLosses || (ledger as any).data?.consecutiveLosses || 0;
  } catch { return 0; }
}

function getLedgerClosedPositions(ledger: Ledger): any[] {
  try {
    return ledger.state?.closedPositions || (ledger as any).data?.closedPositions || [];
  } catch { return []; }
}

function getLedgerLastReset(ledger: Ledger): Date {
  try {
    const resetStr = ledger.state?.lastReset || (ledger as any).data?.lastReset;
    if (resetStr) return new Date(resetStr);
    return new Date();
  } catch { return new Date(); }
}

// ===== DAILY RESET (inline, no method call) =====

async function handleDailyReset(ledger: Ledger, ghSync: GitHubSync): Promise<void> {
  try {
    const now = new Date();
    const lastReset = getLedgerLastReset(ledger);
    
    if (now.getUTCDate() !== lastReset.getUTCDate() || 
        now.getUTCMonth() !== lastReset.getUTCMonth() ||
        now.getUTCFullYear() !== lastReset.getUTCFullYear()) {
      
      const stats = getLedgerStats(ledger);
      const balance = getLedgerBalance(ledger);
      
      log("═══ DAILY SUMMARY (" + lastReset.toLocaleDateString() + ") ═══");
      log("   Balance: $" + balance.toFixed(2));
      log("   P&L: $" + stats.dailyPnl + " (net after fees)");
      log("   Trades: " + stats.totalTrades + " (" + stats.wins + "W/" + stats.losses + "L)");
      log("   Win Rate: " + stats.winRate + "%");
      log("═══════════════════════════════════════");
      
      // Try to call resetDaily if it exists
      if (typeof ledger.resetDaily === "function") {
        ledger.resetDaily();
      } else {
        // Manual reset of daily counters
        try {
          if (ledger.state) {
            ledger.state.lastReset = now.toISOString();
            if (typeof ledger.state.dailyPnl !== "undefined") ledger.state.dailyPnl = 0;
            if (typeof ledger.state.dailyTrades !== "undefined") ledger.state.dailyTrades = 0;
          }
          if ((ledger as any).data) {
            (ledger as any).data.lastReset = now.toISOString();
            if (typeof (ledger as any).data.dailyPnl !== "undefined") (ledger as any).data.dailyPnl = 0;
            if (typeof (ledger as any).data.dailyTrades !== "undefined") (ledger as any).data.dailyTrades = 0;
          }
        } catch (e) {
          error("Manual daily reset error: " + e);
        }
      }
      
      if (typeof ledger.save === "function") {
        await ledger.save();
      }
      await ghSync.pushLedger();
    }
  } catch (err) {
    error("Daily reset check error: " + (err instanceof Error ? err.message : String(err)));
  }
}

// ===== MAIN SCAN =====

async function scan(ledger: Ledger, ghSync: GitHubSync) {
  scanCount++;
  const scanId = "#" + scanCount;

  try {
    // Daily reset check (handled inline — no method call)
    await handleDailyReset(ledger, ghSync);

    // ===== MARKET BRIEF INTEGRATION =====
    const overrides = await getOverrides();
    currentOverrides = overrides;

    const candles = await fetchCandles();
    if (candles.length === 0) {
      if (scanCount % 10 === 0) error(scanId + " No candle data received from any source");
      return;
    }
    
    const currentPrice = candles[candles.length - 1].close;
    if (currentPrice <= 0) {
      error(scanId + " Invalid price: " + currentPrice);
      return;
    }

    // ===== SWING ANALYSIS =====
    const swingAnalysis = analyzeSwing(candles);
    const currentAtr = swingAnalysis?.atrPercent || 0.5;

    // ===== POSITION MANAGEMENT (always runs) =====
    const openPositions = getLedgerOpenPositions(ledger);
    let positionClosed = false;
    
    for (const position of [...openPositions]) {
      // Get or create trailing state
      let trailState = trailingStops.get(position.id);
      if (!trailState) {
        trailState = {
          positionId: position.id,
          highWaterMark: 0,
          stopMovedToBreakeven: false,
          trailingStopPrice: null,
          entryTime: position.entryTime || Date.now(),
        };
        trailingStops.set(position.id, trailState);
      }
      
      // Use trailing stop manager (includes hard circuit breaker + loss cap)
      const trailResult = manageTrailingStop(position, currentPrice, trailState, currentAtr);
      
      // Also check recovery manager's logic as backup
      let recoveryResult = { shouldClose: false, reason: "", exitPrice: currentPrice };
      try {
        recoveryResult = updatePosition(position, currentPrice, ABSOLUTE_MAX_HOLD_SECONDS);
      } catch (e) {
        // Recovery manager might not handle all position shapes
      }
      
      const shouldClose = trailResult.shouldClose || recoveryResult.shouldClose;
      const closeReason = trailResult.shouldClose ? trailResult.reason : (recoveryResult.reason || "unknown");
      const exitPrice = trailResult.shouldClose ? trailResult.exitPrice : (recoveryResult.exitPrice || currentPrice);
      
      if (shouldClose) {
        // Live execution
        if (config.tradingMode === "live" && coinbaseTrader && coinbaseClient?.productId) {
          try {
            const contracts = CoinbaseTrader.calculateContracts(
              (position.collateral || config.risk.positionSizeDollars) * (position.leverage || config.futures.leverage),
              currentPrice
            );
            await coinbaseTrader.closePosition(
              coinbaseClient.productId,
              position.side,
              contracts
            );
          } catch (err) {
            error("❌ Live close failed: " + (err instanceof Error ? err.message : String(err)));
          }
        }

        let closed: any = null;
        try {
          closed = await ledger.closePosition(position.id, exitPrice, closeReason);
        } catch (err) {
          error("❌ Ledger close failed: " + (err instanceof Error ? err.message : String(err)));
        }
        
        const pnl = closed?.pnl || 0;
        const fees = closed?.fees || 0;
        const grossPnl = closed?.grossPnl || 0;
        const emoji = pnl >= 0 ? "💰" : "💸";
        const timeElapsed = ((closed?.exitTime || Date.now()) - (closed?.entryTime || trailState.entryTime)) / 1000;
        const modeTag = position.mode ? ` [${position.mode.toUpperCase()}]` : " [SWING]";
        
        log(emoji + " CLOSED " + position.side + modeTag + " NET $" + pnl.toFixed(2) + 
            " (gross $" + grossPnl.toFixed(2) + " - $" + fees.toFixed(2) + " fees) in " + 
            Math.round(timeElapsed / 60) + "min | " + closeReason);
        
        if (trailState.highWaterMark > 0) {
          log("   📊 Peak unrealized: $" + trailState.highWaterMark.toFixed(2) + 
              " | BE stop: " + (trailState.stopMovedToBreakeven ? "YES" : "no") +
              " | Trail stop: " + (trailState.trailingStopPrice ? "$" + trailState.trailingStopPrice.toFixed(2) : "none"));
        }
        
        trailingStops.delete(position.id);
        positionClosed = true;
        
        if (pnl < 0) {
          lastLossTime = Date.now();
          if (pnl < -15 && Date.now() - lastOptimizerTrigger > OPTIMIZER_COOLDOWN_MS) {
            lastOptimizerTrigger = Date.now();
            await triggerOptimizer("Big loss: $" + pnl.toFixed(2));
          }
        }
      } else {
        // Log position status periodically
        if (scanCount % 10 === 0) {
          const holdSec = (Date.now() - trailState.entryTime) / 1000;
          const isLong = position.side === "Long";
          const pMovePct = isLong
            ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
            : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
          const notional = (position.collateral || config.risk.positionSizeDollars) * (position.leverage || config.futures.leverage);
          const uPnl = (pMovePct / 100) * notional;
          
          log(scanId + " 📍 " + position.side + " @ $" + position.entryPrice.toFixed(2) + 
              " | " + pMovePct.toFixed(2) + "% ($" + uPnl.toFixed(2) + ") | " +
              Math.round(holdSec / 60) + "min | HWM: $" + trailState.highWaterMark.toFixed(2) +
              " | BE: " + (trailState.stopMovedToBreakeven ? "✅" : "—") +
              " | Trail: " + (trailState.trailingStopPrice ? "$" + trailState.trailingStopPrice.toFixed(2) : "—"));
        }
      }
    }

    if (positionClosed) {
      try { await ghSync.pushLedger(); } catch (e) { error("GitHub push failed: " + e); }
    }

    // Periodic GitHub sync
    if (Date.now() - lastGitHubSync > GITHUB_SYNC_INTERVAL_MS) {
      lastGitHubSync = Date.now();
      try { await ghSync.pushLedger(); } catch (e) { /* silent */ }
    }

    // Status log
    if (scanCount % 10 === 0 || positionClosed) {
      const stats = getLedgerStats(ledger);
      const balance = getLedgerBalance(ledger);
      const brief = getCurrentBrief();
      const regimeTag = brief ? ` | 📊 ${brief.regime}` : "";
      const modeTag = config.tradingMode === "live" ? " 🔴 LIVE" : " 📝 PAPER";
      const exchangeTag = coinbaseClient ? " [CB]" : " [BN]";
      const swingTag = swingAnalysis 
        ? ` | ${swingAnalysis.trend}(${swingAnalysis.trendStrength.toFixed(2)}) ATR:${swingAnalysis.atrPercent.toFixed(2)}% RSI:${swingAnalysis.rsi14.toFixed(1)}` 
        : "";
      
      log(scanId + " 💎 $" + balance.toFixed(2) + 
          " | Day: $" + stats.dailyPnl + " | " + stats.totalTrades + " trades (" + stats.winRate + "% W)" +
          " | BTC: $" + currentPrice.toFixed(2) + swingTag + regimeTag + modeTag + exchangeTag);
    }

    // ===== ENTRY LOGIC =====
    
    // Check if trading is allowed
    if (overrides.tradingEnabled === false) {
      if (scanCount % 10 === 0) log(scanId + " 🚫 Trading disabled by brief: " + (overrides.reason || "no reason"));
      return;
    }

    const currentOpenPositions = getLedgerOpenPositions(ledger);
    if (currentOpenPositions.length > 0) {
      return; // Already in a position
    }

    // Risk checks
    const stats = getLedgerStats(ledger);
    if (stats.dailyPnl < 0 && Math.abs(stats.dailyPnl) >= config.risk.maxDailyLossDollars) {
      if (scanCount % 20 === 0) log(scanId + " ⛔ Daily loss limit reached: $" + stats.dailyPnl);
      return;
    }

    // Post-loss cooldown
    if (lastLossTime > 0 && (Date.now() - lastLossTime) < POST_LOSS_COOLDOWN_MS) {
      const remaining = Math.ceil((POST_LOSS_COOLDOWN_MS - (Date.now() - lastLossTime)) / 1000);
      if (scanCount % 10 === 0) log(scanId + " ⏳ Post-loss cooldown: " + remaining + "s remaining");
      return;
    }

    // Consecutive loss pause
    const consecutiveLosses = getLedgerConsecutiveLosses(ledger);
    if (consecutiveLosses >= config.risk.maxConsecutiveLosses) {
      const pauseUntil = lastLossTime + (config.risk.pauseAfterLossesMinutes * 60_000);
      if (Date.now() < pauseUntil) {
        const remaining = Math.ceil((pauseUntil - Date.now()) / 60_000);
        if (scanCount % 10 === 0) log(scanId + " ⏸️ Paused after " + consecutiveLosses + " consecutive losses (" + remaining + "m left)");
        return;
      }
    }

    // Hourly trade limit
    const closedPositions = getLedgerClosedPositions(ledger);
    const recentTrades = closedPositions.filter(
      (t: any) => t.entryTime && (Date.now() - t.entryTime) < 3_600_000
    );
    if (recentTrades.length >= config.risk.maxTradesPerHour) {
      if (scanCount % 10 === 0) log(scanId + " ⏳ Hourly trade limit reached (" + recentTrades.length + "/" + config.risk.maxTradesPerHour + ")");
      return;
    }

    // Min signal interval
    if (Date.now() - lastSignalTime < MIN_SIGNAL_INTERVAL) {
      return;
    }

    // ===== SWING SIGNAL DETECTION =====
    if (!swingAnalysis) {
      if (scanCount % 10 === 0) log(scanId + " 📊 Insufficient data for swing analysis");
      return;
    }
    
    const swingSignal = detectSwingEntry(candles, swingAnalysis, overrides);
    
    if (!swingSignal.detected) {
      if (scanCount % 5 === 0) {
        log(scanId + " 🔍 " + swingSignal.reason);
      }
      return;
    }
    
    // Confidence filter
    if (swingSignal.confidence < 0.45) {
      log(scanId + " 🔍 Signal too weak: " + swingSignal.reason + " (conf: " + swingSignal.confidence.toFixed(2) + ")");
      return;
    }
    
    // SHORT PENALTY: Require much higher confidence for shorts (0% historical WR)
    if (swingSignal.side === "Short" && swingSignal.confidence < 0.7) {
      log(scanId + " 📉 Short signal rejected — need 0.70+ confidence (got " + swingSignal.confidence.toFixed(2) + ") due to 0% short WR");
      return;
    }
    
    // Apply bias from brief
    let finalSide = swingSignal.side;
    if (overrides.bias === "long" && finalSide === "Short") {
      log(scanId + " 📊 Brief says long bias — skipping Short signal");
      return;
    }
    if (overrides.bias === "short" && finalSide === "Long" && swingSignal.mode !== "bounce") {
      log(scanId + " 📊 Brief says short bias — skipping Long signal (except bounce plays)");
      return;
    }

    // FIRE! Open position
    log("🚀 SWING SIGNAL: " + swingSignal.reason + " (conf: " + swingSignal.confidence.toFixed(2) + ")");
    lastSignalTime = Date.now();

    const collateral = config.risk.positionSizeDollars;
    const leverage = config.futures.leverage;
    const notional = collateral * leverage;
    
    const position = createPosition(finalSide, currentPrice, collateral, swingSignal.mode);
    
    // Dynamic stop based on ATR
    let stopPercent = Math.min(0.5, swingAnalysis.atrPercent * 0.6);
    let targetPercent = Math.min(2.0, swingAnalysis.atrPercent * 2.0);
    
    // Longs get slightly wider targets (they work better)
    if (finalSide === "Long") {
      targetPercent = Math.min(2.5, swingAnalysis.atrPercent * 2.5);
    }
    
    // Bounce plays: tighter stops, quicker targets
    if (swingSignal.mode === "bounce") {
      stopPercent = Math.min(0.4, swingAnalysis.atrPercent * 0.5);
      targetPercent = Math.min(1.5, swingAnalysis.atrPercent * 1.5);
    }
    
    if (finalSide === "Long") {
      position.stopLoss = currentPrice * (1 - stopPercent / 100);
      position.takeProfit = currentPrice * (1 + targetPercent / 100);
    } else {
      position.stopLoss = currentPrice * (1 + stopPercent / 100);
      position.takeProfit = currentPrice * (1 - targetPercent / 100);
    }
    
    // Live execution
    if (config.tradingMode === "live" && coinbaseTrader && coinbaseClient?.productId) {
      try {
        const contracts = CoinbaseTrader.calculateContracts(notional, currentPrice);
        await coinbaseTrader.openPosition(
          coinbaseClient.productId,
          finalSide,
          contracts
        );
      } catch (err) {
        error("❌ Live open failed: " + (err instanceof Error ? err.message : String(err)));
        return;
      }
    }
    
    try {
      await ledger.openPosition(position);
    } catch (err) {
      error("❌ Ledger open failed: " + (err instanceof Error ? err.message : String(err)));
      return;
    }
    
    const stopDist = Math.abs((currentPrice - position.stopLoss) / currentPrice * 100);
    const targetDist = Math.abs((position.takeProfit - currentPrice) / currentPrice * 100);
    const maxLoss = (stopDist / 100) * notional;
    const maxProfit = (targetDist / 100) * notional;
    
    log("📈 OPENED " + finalSide + " [" + swingSignal.mode.toUpperCase() + "] @ $" + currentPrice.toFixed(2) + 
        " | Stop: $" + position.stopLoss.toFixed(2) + " (-" + stopDist.toFixed(2) + "% / -$" + maxLoss.toFixed(2) + ")" +
        " | Target: $" + position.takeProfit.toFixed(2) + " (+" + targetDist.toFixed(2) + "% / +$" + maxProfit.toFixed(2) + ")" +
        " | ATR: " + swingAnalysis.atrPercent.toFixed(2) + "% | RSI: " + swingAnalysis.rsi14.toFixed(1) +
        " | Trailing: BE@" + BREAKEVEN_TRIGGER_PERCENT + "%, adaptive trail");
    
    try { await ghSync.pushLedger(); } catch (e) { error("GitHub push failed: " + e); }

  } catch (err) {
    error(scanId + " Scan error: " + (err instanceof Error ? err.message : String(err)));
  }
}

async function main() {
  log("═══════════════════════════════════════");
  log("  KALLISTI v7.0 — SWING TRADER (LONG BIAS)");
  log("  Support Bounce + Pullback + Trend Follow");
  log("  Mode: " + config.tradingMode.toUpperCase());
  log("  Exchange: Coinbase CFM");
  log("  Leverage: " + config.futures.leverage + "x");
  log("  Position: $" + config.risk.positionSizeDollars + " × " + config.futures.leverage + "x = $" + (config.risk.positionSizeDollars * config.futures.leverage));
  log("  Fees: " + config.fees.takerFeePercent + "% taker / " + config.fees.makerFeePercent + "% maker");
  log("  Max hold: " + ABSOLUTE_MAX_HOLD_SECONDS + "s | Max loss: $" + ABSOLUTE_MAX_LOSS_DOLLARS);
  log("  Trailing: BE@" + BREAKEVEN_TRIGGER_PERCENT + "%, adaptive ATR trail");
  log("  Short penalty: requires 0.70+ confidence (0% historical WR)");
  log("══════════════════════════════════════════════════");

  // Health check server — [docs.cdp.coinbase.com](https://docs.cdp.coinbase.com/get-started/develop-with-ai/ai-troubleshooting)
  const PORT = parseInt(process.env.PORT || "3000");
  try {
    Bun.serve({
      port: PORT,
      fetch(req: Request) {
        const url = new URL(req.url);
        if (url.pathname === "/health") {
          return new Response(JSON.stringify({ 
            status: "ok", 
            version: "v7.0-swing-longbias", 
            uptime: process.uptime(),
            scanCount,
            tradingMode: config.tradingMode,
          }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/status") {
          try {
            return new Response(JSON.stringify({
              version: "v7.0",
              uptime: process.uptime(),
              scanCount,
              tradingMode: config.tradingMode,
              currentOverrides,
              trailingStops: trailingStops.size,
            }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch {
            return new Response('{"status":"error"}', { status: 500 });
          }
        }
        return new Response("Kallisti Swing Trader v7.0 — Long Bias", { status: 200 });
      },
    });
    log(`Health check listening on port ${PORT}`);
  } catch (portErr) {
    // Try alternate ports if primary fails
    const altPorts = [3001, 3002];
    let bound = false;
    for (const altPort of altPorts) {
      try {
        Bun.serve({
          port: altPort,
          fetch(req: Request) {
            return new Response(JSON.stringify({ status: "ok", version: "v7.0" }), {
              headers: { "Content-Type": "application/json" },
            });
          },
        });
        log(`Health check listening on fallback port ${altPort}`);
        bound = true;
        break;
      } catch { /* try next */ }
    }
    if (!bound) {
      error("Could not bind health check to any port — continuing without it");
    }
  }

  // Initialize exchange clients
  try {
    if (config.auth.keyName && config.auth.privateKey) {
      coinbaseClient = new CoinbaseClient(
        config.dataSource.baseUrl,
        config.auth.keyName,
        config.auth.privateKey
      );
      
      if (config.tradingMode === "live") {
        coinbaseTrader = new CoinbaseTrader(
          config.auth.keyName,
          config.auth.privateKey
        );
        log("🔴 LIVE trading enabled on Coinbase CFM");
      }
    } else {
      log("⚠️ No Coinbase credentials — using Binance for market data, paper trading only");
    }
  } catch (err) {
    error("Exchange client init error: " + (err instanceof Error ? err.message : String(err)));
  }

  // Initialize ledger and GitHub sync
  const ledger = new Ledger();
  const ghSync = new GitHubSync(ledger);

  // Load persisted ledger
  try {
    await ghSync.pullLedger();
    const balance = getLedgerBalance(ledger);
    log(`Ledger loaded: $${balance.toFixed(2)}`);
  } catch (err) {
    log("Starting with fresh ledger: " + (err instanceof Error ? err.message : String(err)));
  }

  // Daily reset check — INLINE, no method call
  // This was the v6.0 crash: ledger.checkDailyReset() doesn't exist
  // We handle it safely in handleDailyReset() called from scan()
  try {
    await handleDailyReset(ledger, ghSync);
  } catch (err) {
    error("Initial daily reset check failed (non-fatal): " + (err instanceof Error ? err.message : String(err)));
  }

  // Scan loop
  log(`Starting scan loop (every ${SCAN_INTERVAL_MS / 1000}s)...`);
  
  const runScan = async () => {
    try {
      await scan(ledger, ghSync);
    } catch (err) {
      error("Scan loop error: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  // First scan immediately
  await runScan();
  
  // Then every SCAN_INTERVAL_MS
  setInterval(runScan, SCAN_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});