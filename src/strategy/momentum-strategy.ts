// KALLISTI v11.0 - Regime-Adaptive Dual-Mode Strategy
// v11.0: COMPLETE REWRITE addressing critical optimizer findings
//
// CRITICAL FIXES:
//   1. Null-safe Coinbase candle parsing (raw?.replace crash)
//   2. Removed '15min stability' gate — trade immediately after regime change
//   3. Uses researcher's ATR instead of broken local 1m ATR calculation
//   4. Regime-aware mode switching: mean reversion in chop, momentum in trends
//   5. Minimum 5-minute hold (no more sub-2-minute stop-outs)
//   6. Wider stops in high-vol to avoid noise stops
//   7. Max 2 trades/hour to reduce churn
//
// STRATEGY MODES:
//   A. HIGH_VOL_CHOP → Mean Reversion primary (fade extremes, tight targets)
//   B. TRENDING → Momentum/Pullback (ride the move, trailing stop)
//   C. LOW_VOL → Wait (no edge, skip)
//
// EXCHANGE: Coinbase CFM (CFTC-regulated)
//   - Leverage: 10x intraday
//   - Position: $500 × 10x = $5,000 notional
//   - Taker fee: 0.03% per side ($3 round-trip)
//   - Maker fee: 0% (promotional!)

import { config } from "../config";

// ═══════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MomentumSignal {
  detected: boolean;
  reason?: string;
  strength?: number;
  side?: "Long" | "Short";
  mode?: "momentum" | "mean_reversion" | "swing_trend" | "swing_divergence" | "swing_pullback";
  suggestedMinHoldSeconds?: number;
  stopPercent?: number;
  targetPercent?: number;
  hardMaxHoldSeconds?: number;
  trailingStop?: {
    activationPercent: number;
    trailPercent: number;
  };
  maxLossDollars?: number;
}

export interface BriefDirective {
  momentumActive: boolean;
  meanReversionActive: boolean;
  aggression: number;
  bias: "long" | "short" | "neutral";
  regime: string;
  regimeConfidence: number;
  recommendedThreshold?: number;
  volatility?: {
    atrPercent: number;       // Researcher's ATR% (hourly) — USE THIS not local calc
    range24hPercent?: number;
    dailyRange?: number;
  };
  trendData?: {
    ema20Distance?: number;
    ema50Distance?: number;
    deathCross?: boolean;
    goldenCross?: boolean;
    atrPercent?: number;
    range24hPercent?: number;
  };
}

export interface OrderbookImbalance {
  bidTotal: number;
  askTotal: number;
  ratio: number;
  lean: "long" | "short" | "neutral";
  strength: number;
}

// ═══════════════════════════════════════════════════════════════════════
// REGIME CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════

type RegimeMode = "mean_reversion" | "trend_follow" | "wait";

interface RegimeConfig {
  mode: RegimeMode;
  minStrength: number;
  stopMultiplier: number;      // Multiplier on ATR for stop
  targetMultiplier: number;    // Multiplier on ATR for target
  minHoldSeconds: number;
  maxHoldSeconds: number;
  trailingStopEnabled: boolean;
}

const REGIME_CONFIGS: Record<string, RegimeConfig> = {
  // High vol chop: mean reversion, fade extremes, tighter targets
  high_vol_chop: {
    mode: "mean_reversion",
    minStrength: 0.40,
    stopMultiplier: 0.7,       // 0.7x ATR stop — wider to survive noise
    targetMultiplier: 0.5,     // 0.5x ATR target — take profits quickly
    minHoldSeconds: 300,       // 5 min minimum
    maxHoldSeconds: 1800,      // 30 min max in chop
    trailingStopEnabled: false,
  },
  // Trending: ride the move
  trending: {
    mode: "trend_follow",
    minStrength: 0.35,
    stopMultiplier: 0.5,
    targetMultiplier: 1.5,
    minHoldSeconds: 600,       // 10 min minimum
    maxHoldSeconds: 3600,      // 60 min max
    trailingStopEnabled: true,
  },
  // Low vol: generally skip
  low_vol: {
    mode: "wait",
    minStrength: 0.70,         // Very high bar
    stopMultiplier: 1.0,
    targetMultiplier: 1.0,
    minHoldSeconds: 300,
    maxHoldSeconds: 1200,
    trailingStopEnabled: false,
  },
  // Unknown/default: conservative trend following
  unknown: {
    mode: "trend_follow",
    minStrength: 0.50,
    stopMultiplier: 0.6,
    targetMultiplier: 1.0,
    minHoldSeconds: 300,
    maxHoldSeconds: 2400,
    trailingStopEnabled: true,
  },
};

function getRegimeConfig(regime: string): RegimeConfig {
  const normalized = regime.toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized.includes("high_vol") && normalized.includes("chop")) return REGIME_CONFIGS.high_vol_chop;
  if (normalized.includes("trend") || normalized.includes("bull") || normalized.includes("bear")) return REGIME_CONFIGS.trending;
  if (normalized.includes("low_vol") || normalized.includes("range_bound") || normalized.includes("quiet")) return REGIME_CONFIGS.low_vol;
  return REGIME_CONFIGS[normalized] || REGIME_CONFIGS.unknown;
}

// ═══════════════════════════════════════════════════════════════════════
// BRIEF PARSER — with volatility extraction
// ═══════════════════════════════════════════════════════════════════════

export function parseBriefDirective(brief: any): BriefDirective {
  const defaults: BriefDirective = {
    momentumActive: true,
    meanReversionActive: true,
    aggression: 0.5,
    bias: "neutral",
    regime: "unknown",
    regimeConfidence: 0.5,
  };

  if (!brief || typeof brief !== "object") return defaults;

  try {
    const ms = brief.momentum_scalper || brief.momentumScalper || {};
    const mr = brief.mean_reversion || brief.meanReversion || {};

    const momentumActive = ms.active !== undefined ? Boolean(ms.active) : defaults.momentumActive;
    const meanReversionActive = mr.active !== undefined ? Boolean(mr.active) : defaults.meanReversionActive;

    let aggression = defaults.aggression;
    const rawAggression = ms.aggression || brief.aggression;
    if (typeof rawAggression === "number") {
      aggression = Math.max(0.1, Math.min(1.0, rawAggression));
    } else if (typeof rawAggression === "string") {
      const aggMap: Record<string, number> = {
        conservative: 0.3, moderate: 0.5, aggressive: 0.8, maximum: 1.0,
      };
      aggression = aggMap[rawAggression.toLowerCase()] || 0.5;
    }

    let bias: "long" | "short" | "neutral" = "neutral";
    const rawBias = brief.bias || ms.bias || "";
    if (typeof rawBias === "string") {
      const lb = rawBias.toLowerCase();
      if (lb.includes("short") || lb.includes("bear")) bias = "short";
      else if (lb.includes("long") || lb.includes("bull")) bias = "long";
    }

    const regime = (brief.regime || brief.market_regime || "unknown").toString().toLowerCase();

    let regimeConfidence = 0.5;
    const rawConfidence = brief.regime_confidence || brief.regimeConfidence || brief.confidence;
    if (typeof rawConfidence === "number") {
      regimeConfidence = Math.max(0, Math.min(1, rawConfidence));
    }

    let recommendedThreshold: number | undefined;
    const rawThreshold = ms.threshold || brief.threshold;
    if (typeof rawThreshold === "number" && rawThreshold > 0 && rawThreshold < 5) {
      recommendedThreshold = rawThreshold;
    }

    // CRITICAL: Extract volatility data from researcher brief
    // This is the AUTHORITATIVE source for ATR, not our broken local 1m calculation
    const volatility: BriefDirective["volatility"] = {} as any;
    let hasVolatility = false;

    // Try multiple possible field names
    const volSources = [
      brief.volatility,
      brief.vol,
      brief.technical,
      brief.trend_data,
      brief.trendData,
      ms,
    ];

    for (const src of volSources) {
      if (!src || typeof src !== "object") continue;

      const atrFields = ["atr_percent", "atrPercent", "atr_pct", "atrPct", "atr"];
      for (const field of atrFields) {
        if (typeof src[field] === "number" && src[field] > 0 && src[field] < 20) {
          volatility!.atrPercent = src[field];
          hasVolatility = true;
          break;
        }
        // Also try parsing string like "1.05%"
        if (typeof src[field] === "string") {
          const parsed = parseFloat(src[field]);
          if (!isNaN(parsed) && parsed > 0 && parsed < 20) {
            volatility!.atrPercent = parsed;
            hasVolatility = true;
            break;
          }
        }
      }
      if (volatility!.atrPercent) break;
    }

    // Range data
    const rangeFields = ["range_24h_percent", "range24hPercent", "daily_range", "dailyRange", "range_24h"];
    for (const src of volSources) {
      if (!src || typeof src !== "object") continue;
      for (const field of rangeFields) {
        if (typeof src[field] === "number" && src[field] > 0) {
          volatility!.range24hPercent = src[field];
          hasVolatility = true;
          break;
        }
      }
      if (volatility!.range24hPercent) break;
    }

    // Extract trend data
    const trendData: BriefDirective["trendData"] = {};
    let hasTrendData = false;
    const td = brief.trend_data || brief.trendData || brief.technical || {};

    const trendFieldMappings: Array<[string[], keyof NonNullable<BriefDirective["trendData"]>]> = [
      [["ema20_distance", "ema20Distance"], "ema20Distance"],
      [["ema50_distance", "ema50Distance"], "ema50Distance"],
      [["atr_percent", "atrPercent"], "atrPercent"],
      [["range_24h_percent", "range24hPercent"], "range24hPercent"],
    ];

    for (const [fields, key] of trendFieldMappings) {
      for (const f of fields) {
        if (typeof td[f] === "number") {
          (trendData as any)[key] = td[f];
          hasTrendData = true;
          break;
        }
      }
    }

    if (td.death_cross || td.deathCross) { trendData.deathCross = true; hasTrendData = true; }
    if (td.golden_cross || td.goldenCross) { trendData.goldenCross = true; hasTrendData = true; }

    // If we got ATR from trend_data but not from volatility, copy it
    if (!volatility!.atrPercent && trendData.atrPercent) {
      volatility!.atrPercent = trendData.atrPercent;
      hasVolatility = true;
    }

    return {
      momentumActive,
      meanReversionActive,
      aggression,
      bias,
      regime,
      regimeConfidence,
      recommendedThreshold,
      volatility: hasVolatility ? volatility : undefined,
      trendData: hasTrendData ? trendData : undefined,
    };
  } catch {
    return defaults;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ORDERBOOK IMBALANCE
// ═══════════════════════════════════════════════════════════════════════

export function computeOrderbookImbalance(
  bids?: Array<{ price: number; size: number }>,
  asks?: Array<{ price: number; size: number }>
): OrderbookImbalance {
  const neutral: OrderbookImbalance = {
    bidTotal: 0, askTotal: 0, ratio: 1, lean: "neutral", strength: 0,
  };

  if (!bids?.length || !asks?.length) return neutral;

  const topBids = bids.slice(0, 10);
  const topAsks = asks.slice(0, 10);

  const bidTotal = topBids.reduce((s, b) => s + b.size * b.price, 0);
  const askTotal = topAsks.reduce((s, a) => s + a.size * a.price, 0);

  if (bidTotal === 0 || askTotal === 0) return neutral;

  const ratio = bidTotal / askTotal;

  let lean: "long" | "short" | "neutral" = "neutral";
  let strength = 0;

  if (ratio < 0.80) {
    lean = "short";
    strength = Math.min((0.80 - ratio) / 0.40, 1.0);
  } else if (ratio > 1.20) {
    lean = "long";
    strength = Math.min((ratio - 1.20) / 0.40, 1.0);
  }

  return { bidTotal, askTotal, ratio, lean, strength };
}

// ═══════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS
// ═══════════════════════════════════════════════════════════════════════

function calcEMA(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcEMASeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function calcRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcATR(candles: Candle[], period: number = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
    trs.push(tr);
  }
  if (trs.length === 0) return 0;
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcMACD(closes: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fastEMA = calcEMASeries(closes, fastPeriod);
  const slowEMA = calcEMASeries(closes, slowPeriod);

  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(fastEMA[i] - slowEMA[i]);
  }

  const signalLine = calcEMASeries(macdLine, signalPeriod);
  const histogram: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    histogram.push(macdLine[i] - signalLine[i]);
  }

  return {
    macd: macdLine[macdLine.length - 1] || 0,
    signal: signalLine[signalLine.length - 1] || 0,
    histogram: histogram[histogram.length - 1] || 0,
    prevHistogram: histogram.length > 1 ? histogram[histogram.length - 2] : 0,
  };
}

function calcBollingerBands(closes: number[], period = 20, stdDevMultiplier = 2) {
  if (closes.length < period) {
    const mid = closes[closes.length - 1] || 0;
    return { upper: mid, middle: mid, lower: mid, width: 0, percentB: 0.5 };
  }

  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + (v - middle) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = middle + stdDev * stdDevMultiplier;
  const lower = middle - stdDev * stdDevMultiplier;
  const width = ((upper - lower) / middle) * 100;
  const currentPrice = closes[closes.length - 1];
  const percentB = upper !== lower ? (currentPrice - lower) / (upper - lower) : 0.5;

  return { upper, middle, lower, width, percentB };
}

/**
 * Stochastic RSI — better for mean reversion entries than plain RSI
 * Returns 0-100, with <20 oversold and >80 overbought
 */
function calcStochRSI(closes: number[], rsiPeriod = 14, stochPeriod = 14): number {
  if (closes.length < rsiPeriod + stochPeriod + 1) return 50;

  // Calculate RSI series
  const rsiValues: number[] = [];
  for (let i = rsiPeriod + 1; i <= closes.length; i++) {
    const rsi = calcRSI(closes.slice(0, i), rsiPeriod);
    rsiValues.push(rsi);
  }

  if (rsiValues.length < stochPeriod) return 50;

  const recentRSI = rsiValues.slice(-stochPeriod);
  const currentRSI = recentRSI[recentRSI.length - 1];
  const minRSI = Math.min(...recentRSI);
  const maxRSI = Math.max(...recentRSI);

  if (maxRSI === minRSI) return 50;
  return ((currentRSI - minRSI) / (maxRSI - minRSI)) * 100;
}

// ═══════════════════════════════════════════════════════════════════════
// CANDLE AGGREGATION
// ═══════════════════════════════════════════════════════════════════════

export function aggregateCandles(candles: Candle[], periodMinutes: number): Candle[] {
  if (candles.length === 0) return [];
  if (periodMinutes <= 1) return candles;

  const periodMs = periodMinutes * 60 * 1000;
  const aggregated: Candle[] = [];
  let bucket: Candle | null = null;
  let bucketStart = 0;

  for (const c of candles) {
    const thisBucketStart = Math.floor(c.time / periodMs) * periodMs;

    if (bucket === null || thisBucketStart !== bucketStart) {
      if (bucket !== null) aggregated.push(bucket);
      bucketStart = thisBucketStart;
      bucket = {
        time: thisBucketStart,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      };
    } else {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume += c.volume;
    }
  }

  if (bucket !== null) aggregated.push(bucket);
  return aggregated;
}

// ═══════════════════════════════════════════════════════════════════════
// EFFECTIVE ATR — Uses researcher data when available, local as fallback
// This is the FIX for the broken ATR calculation issue.
// The local 1m ATR was showing 0.16% while researcher shows 1.05% hourly.
// They measure different things: we need the hourly-scale ATR for position sizing.
// ═══════════════════════════════════════════════════════════════════════

function getEffectiveATRPercent(
  candles: Candle[],
  briefDirective?: BriefDirective,
): number {
  // PRIORITY 1: Researcher's ATR (hourly, most accurate)
  if (briefDirective?.volatility?.atrPercent && briefDirective.volatility.atrPercent > 0) {
    return briefDirective.volatility.atrPercent;
  }

  // PRIORITY 2: ATR from trend data
  if (briefDirective?.trendData?.atrPercent && briefDirective.trendData.atrPercent > 0) {
    return briefDirective.trendData.atrPercent;
  }

  // PRIORITY 3: Estimate from 24h range (range ≈ 4-6x ATR typically)
  if (briefDirective?.volatility?.range24hPercent && briefDirective.volatility.range24hPercent > 0) {
    return briefDirective.volatility.range24hPercent / 5;
  }

  // PRIORITY 4: Local calculation on available candles, scaled up
  // If we have 1m candles, ATR will be tiny. Scale up to ~hourly equivalent.
  if (candles.length >= 5) {
    const localATR = calcATR(candles, Math.min(14, candles.length - 1));
    const price = candles[candles.length - 1].close;
    if (price > 0 && localATR > 0) {
      const localATRPct = (localATR / price) * 100;
      // 1m ATR → hourly: multiply by sqrt(60) ≈ 7.75
      // This is approximate but much better than raw 1m ATR
      const hourlyEstimate = localATRPct * Math.sqrt(60);
      return hourlyEstimate;
    }
  }

  // PRIORITY 5: Default reasonable assumption for BTC
  return 0.8;
}

// ═══════════════════════════════════════════════════════════════════════
// TREND ASSESSMENT
// ═══════════════════════════════════════════════════════════════════════

interface TrendAssessment {
  direction: "bullish" | "bearish" | "neutral";
  strength: number;
  ema9: number;
  ema21: number;
  ema50: number;
  rsi: number;
  stochRSI: number;
  macd: { macd: number; signal: number; histogram: number; prevHistogram: number };
  atrPercent: number;             // Effective ATR from researcher or scaled local
  localAtrPercent: number;        // Raw local 1m ATR for reference
  bbands: { upper: number; middle: number; lower: number; width: number; percentB: number };
  priceVsEma9Pct: number;
  priceVsEma21Pct: number;
  priceVsEma50Pct: number;
  isMacdCrossUp: boolean;
  isMacdCrossDown: boolean;
  isHistogramGrowing: boolean;
}

function assessTrend(candles: Candle[], briefDirective?: BriefDirective): TrendAssessment {
  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1] || 0;

  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, Math.min(50, closes.length));
  const rsi = calcRSI(closes, 14);
  const stochRSI = calcStochRSI(closes, 14, 14);
  const macd = calcMACD(closes, 12, 26, 9);

  // Local ATR (raw 1m)
  const localATR = calcATR(candles, 14);
  const localAtrPercent = currentPrice > 0 ? (localATR / currentPrice) * 100 : 0;

  // Effective ATR (researcher or scaled)
  const atrPercent = getEffectiveATRPercent(candles, briefDirective);

  const bbands = calcBollingerBands(closes, 20, 2);

  const priceVsEma9Pct = ema9 > 0 ? ((currentPrice - ema9) / ema9) * 100 : 0;
  const priceVsEma21Pct = ema21 > 0 ? ((currentPrice - ema21) / ema21) * 100 : 0;
  const priceVsEma50Pct = ema50 > 0 ? ((currentPrice - ema50) / ema50) * 100 : 0;

  const isMacdCrossUp = macd.histogram > 0 && macd.prevHistogram <= 0;
  const isMacdCrossDown = macd.histogram < 0 && macd.prevHistogram >= 0;
  const isHistogramGrowing = Math.abs(macd.histogram) > Math.abs(macd.prevHistogram);

  // Trend direction scoring
  let score = 0;
  if (ema9 > ema21) score += 1; else score -= 1;
  if (ema21 > ema50) score += 1; else score -= 1;
  if (currentPrice > ema9) score += 0.5; else score -= 0.5;
  if (currentPrice > ema21) score += 0.5; else score -= 0.5;
  if (macd.histogram > 0) score += 0.5; else score -= 0.5;
  if (isHistogramGrowing && macd.histogram > 0) score += 0.5;
  if (isHistogramGrowing && macd.histogram < 0) score -= 0.5;
  if (rsi > 55) score += 0.5; else if (rsi < 45) score -= 0.5;

  let direction: "bullish" | "bearish" | "neutral" = "neutral";
  if (score >= 2) direction = "bullish";
  else if (score <= -2) direction = "bearish";

  const strength = Math.min(Math.abs(score) / 5, 1.0);

  return {
    direction, strength, ema9, ema21, ema50, rsi, stochRSI, macd,
    atrPercent, localAtrPercent,
    bbands, priceVsEma9Pct, priceVsEma21Pct, priceVsEma50Pct,
    isMacdCrossUp, isMacdCrossDown, isHistogramGrowing,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// POSITION IN RANGE
// ═══════════════════════════════════════════════════════════════════════

function positionInRange(candles: Candle[], lookback: number = 20): {
  position: number; range: number; high: number; low: number;
} {
  if (candles.length < 3) return { position: 0.5, range: 0, high: 0, low: 0 };

  const recent = candles.slice(-lookback);
  const currentPrice = candles[candles.length - 1].close;
  const high = Math.max(...recent.map(c => c.high));
  const low = Math.min(...recent.map(c => c.low));
  const range = high - low;

  if (range <= 0) return { position: 0.5, range: 0, high, low };

  const position = (currentPrice - low) / range;
  return { position, range, high, low };
}

// ═══════════════════════════════════════════════════════════════════════
// MEAN REVERSION SIGNAL — Primary mode for high_vol_chop
// ═══════════════════════════════════════════════════════════════════════

/**
 * v11.0: Regime-aware mean reversion.
 * In high_vol_chop, this is the PRIMARY signal source.
 *
 * Entry conditions:
 *   - StochRSI at extreme (<15 or >85)
 *   - Price outside Bollinger Bands OR at band edge
 *   - Recent move was extended (multi-candle run in one direction)
 *   - Preferably: volume declining on the extension (exhaustion)
 *
 * Key difference from v10: uses researcher's ATR for proper sizing,
 * wider stops to survive high-vol noise.
 */
function detectMeanReversionSignal(
  candles1m: Candle[],
  candles5m: Candle[],
  trend: TrendAssessment,
  regimeConfig: RegimeConfig,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });
  const price = candles1m[candles1m.length - 1].close;

  if (candles5m.length < 8) return noSignal("Insufficient 5m candles for MR");

  const closes5m = candles5m.map(c => c.close);
  const bb5m = calcBollingerBands(closes5m, 20, 2);
  const rsi5m = calcRSI(closes5m, 14);

  // Use 1m data for more sensitive stochastic
  const closes1m = candles1m.map(c => c.close);
  const stochRSI = trend.stochRSI;

  // Minimum volatility — need enough movement to trade
  if (trend.atrPercent < 0.3) {
    return noSignal(`MR: ATR too low (${trend.atrPercent.toFixed(2)}%) — no edge @ $${price.toFixed(0)}`);
  }

  // ─── OVERSOLD LONG ───
  const oversold = stochRSI < 15 || (stochRSI < 20 && rsi5m < 35);
  const belowLowerBand = bb5m.percentB < 0.10;
  const nearLowerBand = bb5m.percentB < 0.20;

  // ─── OVERBOUGHT SHORT ───
  const overbought = stochRSI > 85 || (stochRSI > 80 && rsi5m > 65);
  const aboveUpperBand = bb5m.percentB > 0.90;
  const nearUpperBand = bb5m.percentB > 0.80;

  // Check for directional extension over last N candles
  const lookback = Math.min(7, candles5m.length - 1);
  const recentCandles5m = candles5m.slice(-lookback - 1);
  let upCandles = 0;
  let downCandles = 0;
  let totalMove = 0;

  for (let i = 1; i < recentCandles5m.length; i++) {
    const move = recentCandles5m[i].close - recentCandles5m[i - 1].close;
    if (move > 0) upCandles++;
    else if (move < 0) downCandles++;
    totalMove += move;
  }

  const totalMovePct = recentCandles5m[0].close > 0
    ? (totalMove / recentCandles5m[0].close) * 100 : 0;
  const extendedDown = downCandles >= 4 && totalMovePct < -0.15;
  const extendedUp = upCandles >= 4 && totalMovePct > 0.15;

  // Volume exhaustion: declining volume on the extension = better MR signal
  const recentVols = candles5m.slice(-5).map(c => c.volume);
  const volDecreasing = recentVols.length >= 3 &&
    recentVols[recentVols.length - 1] < recentVols[recentVols.length - 3];

  let side: "Long" | "Short" | null = null;
  let strength = 0;
  let reasons: string[] = [];

  // ─── EVALUATE LONG MR ───
  if (oversold && (belowLowerBand || nearLowerBand)) {
    side = "Long";
    strength = 0.25;
    reasons.push(`stochRSI=${stochRSI.toFixed(0)}`);
    reasons.push(`BB%=${bb5m.percentB.toFixed(2)}`);

    if (belowLowerBand) { strength += 0.15; reasons.push("below_BB"); }
    else if (nearLowerBand) { strength += 0.08; }

    if (extendedDown) { strength += 0.15; reasons.push(`extended↓(${downCandles}/${lookback})`); }
    if (volDecreasing) { strength += 0.08; reasons.push("vol_exhaust"); }
    if (stochRSI < 10) { strength += 0.10; reasons.push("deep_oversold"); }

    // OB confirmation (bid-heavy = support)
    if (orderbook && orderbook.lean === "long" && orderbook.strength > 0.2) {
      strength += 0.10 * orderbook.strength;
      reasons.push(`OB_bid:${orderbook.ratio.toFixed(2)}`);
    }

    // Researcher alignment bonus
    if (briefDirective?.bias === "long") {
      strength += 0.10;
      reasons.push("bias_aligned");
    }

    // PENALTY: if researcher says SHORT and confidence is high, reduce strength
    if (briefDirective?.bias === "short" && (briefDirective.regimeConfidence || 0) > 0.7) {
      strength -= 0.15;
      reasons.push("bias_opposed");
    }
  }

  // ─── EVALUATE SHORT MR ───
  if (!side && overbought && (aboveUpperBand || nearUpperBand)) {
    side = "Short";
    strength = 0.25;
    reasons.push(`stochRSI=${stochRSI.toFixed(0)}`);
    reasons.push(`BB%=${bb5m.percentB.toFixed(2)}`);

    if (aboveUpperBand) { strength += 0.15; reasons.push("above_BB"); }
    else if (nearUpperBand) { strength += 0.08; }

    if (extendedUp) { strength += 0.15; reasons.push(`extended↑(${upCandles}/${lookback})`); }
    if (volDecreasing) { strength += 0.08; reasons.push("vol_exhaust"); }
    if (stochRSI > 90) { strength += 0.10; reasons.push("deep_overbought"); }

    if (orderbook && orderbook.lean === "short" && orderbook.strength > 0.2) {
      strength += 0.10 * orderbook.strength;
      reasons.push(`OB_ask:${orderbook.ratio.toFixed(2)}`);
    }

    if (briefDirective?.bias === "short") {
      strength += 0.10;
      reasons.push("bias_aligned");
    }

    if (briefDirective?.bias === "long" && (briefDirective.regimeConfidence || 0) > 0.7) {
      strength -= 0.15;
      reasons.push("bias_opposed");
    }
  }

  if (!side) {
    return noSignal(`MR: no extreme (stochRSI=${stochRSI.toFixed(0)}, BB%=${bb5m.percentB.toFixed(2)}, RSI5m=${rsi5m.toFixed(0)}) @ $${price.toFixed(0)}`);
  }

  // Don't fade moves that are TOO large — could be a breakout
  const maxFadeMove = trend.atrPercent * 2.0; // Don't fade moves > 2x hourly ATR
  if (Math.abs(totalMovePct) > maxFadeMove) {
    return noSignal(`MR: move too large to fade (${Math.abs(totalMovePct).toFixed(2)}% > ${maxFadeMove.toFixed(2)}% limit) — possible breakout @ $${price.toFixed(0)}`);
  }

  strength = Math.max(0, Math.min(1.0, strength));

  if (strength < regimeConfig.minStrength) {
    return noSignal(`MR ${side}: too weak (${strength.toFixed(2)} < ${regimeConfig.minStrength}) @ $${price.toFixed(0)}`);
  }

  // Calculate stop and target using effective ATR
  const stopPercent = Math.max(0.35, trend.atrPercent * regimeConfig.stopMultiplier);
  const targetPercent = Math.max(0.20, trend.atrPercent * regimeConfig.targetMultiplier);

  return {
    detected: true,
    side,
    mode: "mean_reversion",
    reason: `🔄 MR ${side.toUpperCase()}: ${reasons.join(", ")}, ATR=${trend.atrPercent.toFixed(2)}%, target=${targetPercent.toFixed(2)}%, stop=${stopPercent.toFixed(2)}% @ $${price.toFixed(0)}`,
    strength,
    suggestedMinHoldSeconds: regimeConfig.minHoldSeconds,
    stopPercent,
    targetPercent,
    hardMaxHoldSeconds: regimeConfig.maxHoldSeconds,
    trailingStop: regimeConfig.trailingStopEnabled ? {
      activationPercent: targetPercent * 0.6,
      trailPercent: targetPercent * 0.4,
    } : undefined,
    maxLossDollars: 30,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// TREND FOLLOWING SIGNAL — Primary mode for trending regimes
// ═══════════════════════════════════════════════════════════════════════

function detectTrendSignal(
  candles1m: Candle[],
  candles5m: Candle[],
  trend: TrendAssessment,
  regimeConfig: RegimeConfig,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });
  const price = candles1m[candles1m.length - 1].close;

  if (candles5m.length < 10) return noSignal("Insufficient 5m candles for trend");

  // Need clear directional trend
  if (trend.direction === "neutral") {
    return noSignal(`Trend neutral (str:${trend.strength.toFixed(2)}) @ $${price.toFixed(0)}`);
  }

  // ATR bounds
  if (trend.atrPercent < 0.25) {
    return noSignal(`Trend: ATR too low (${trend.atrPercent.toFixed(2)}%) @ $${price.toFixed(0)}`);
  }
  if (trend.atrPercent > 4.0) {
    return noSignal(`Trend: ATR too high (${trend.atrPercent.toFixed(2)}%) — chaos @ $${price.toFixed(0)}`);
  }

  const side: "Long" | "Short" = trend.direction === "bullish" ? "Long" : "Short";

  // Counter-trend blocking
  const counterTrend = briefDirective && (
    (briefDirective.bias === "long" && side === "Short") ||
    (briefDirective.bias === "short" && side === "Long")
  );
  if (counterTrend && (briefDirective!.regimeConfidence || 0) >= 0.7) {
    return noSignal(`🚫 ${side} blocked: counter-trend in ${briefDirective!.regime} (conf:${(briefDirective!.regimeConfidence || 0).toFixed(2)}) @ $${price.toFixed(0)}`);
  }

  // MACD alignment
  const macdAligned = (side === "Long" && trend.macd.histogram > 0) ||
                      (side === "Short" && trend.macd.histogram < 0);
  if (!macdAligned) {
    return noSignal(`${side} trend but MACD opposes (hist:${trend.macd.histogram.toFixed(2)}) @ $${price.toFixed(0)}`);
  }

  // RSI: don't chase into overbought/oversold
  if (side === "Long" && trend.rsi > 72) {
    return noSignal(`Long trend but RSI overbought (${trend.rsi.toFixed(0)}) @ $${price.toFixed(0)}`);
  }
  if (side === "Short" && trend.rsi < 28) {
    return noSignal(`Short trend but RSI oversold (${trend.rsi.toFixed(0)}) @ $${price.toFixed(0)}`);
  }

  // Position in range quality
  const posRange = positionInRange(candles5m, 20);
  const posQuality = side === "Long" ? (1.0 - posRange.position) : posRange.position;

  if (posQuality < 0.15) {
    return noSignal(`${side} trend but bad range position (${posRange.position.toFixed(2)}) @ $${price.toFixed(0)}`);
  }

  // ─── STRENGTH SCORING ───
  let strength = 0;
  const reasons: string[] = [];

  // Trend strength (0-0.25)
  strength += trend.strength * 0.25;
  reasons.push(`trend=${trend.direction}(${trend.strength.toFixed(2)})`);

  // MACD momentum growing (0-0.2)
  if (trend.isHistogramGrowing) {
    strength += 0.15;
    reasons.push("MACD↑");
  } else {
    strength += 0.05;
  }

  // MACD crossover (0-0.15)
  if ((side === "Long" && trend.isMacdCrossUp) || (side === "Short" && trend.isMacdCrossDown)) {
    strength += 0.15;
    reasons.push("MACD_cross");
  }

  // Position quality (0-0.12)
  strength += posQuality * 0.12;

  // Researcher alignment (0-0.15)
  const researcherAligned = briefDirective &&
    ((briefDirective.bias === "long" && side === "Long") ||
     (briefDirective.bias === "short" && side === "Short"));
  if (researcherAligned) {
    strength += 0.15 * (briefDirective!.regimeConfidence || 0.5);
    reasons.push("bias_aligned");
  }

  // OB alignment (0-0.1)
  if (orderbook && orderbook.strength > 0.2) {
    if ((orderbook.lean === "long" && side === "Long") ||
        (orderbook.lean === "short" && side === "Short")) {
      strength += 0.10 * orderbook.strength;
      reasons.push(`OB:${orderbook.ratio.toFixed(2)}`);
    }
  }

  // Volume confirmation
  const recentVols = candles5m.slice(-5).map(c => c.volume);
  const avgVol = recentVols.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, recentVols.length - 1);
  const currentVol = recentVols[recentVols.length - 1] || 0;
  const volRatio = avgVol > 0 ? currentVol / avgVol : 1;
  if (volRatio > 1.5) { strength += 0.05; reasons.push(`vol=${volRatio.toFixed(1)}x`); }
  if (volRatio < 0.3) { strength -= 0.10; }

  // Counter-trend penalty
  if (counterTrend) { strength -= 0.20; reasons.push("counter_trend"); }

  strength = Math.max(0, Math.min(1.0, strength));

  if (strength < regimeConfig.minStrength) {
    return noSignal(`${side} trend too weak (${strength.toFixed(2)} < ${regimeConfig.minStrength}) [${reasons.join(", ")}] @ $${price.toFixed(0)}`);
  }

  // Calculate stop and target
  const stopPercent = Math.max(0.35, trend.atrPercent * regimeConfig.stopMultiplier);
  const targetPercent = Math.max(0.50, trend.atrPercent * regimeConfig.targetMultiplier);

  reasons.push(`RSI=${trend.rsi.toFixed(0)}`);
  reasons.push(`ATR=${trend.atrPercent.toFixed(2)}%`);

  return {
    detected: true,
    side,
    mode: "swing_trend",
    reason: `📈 TREND ${side.toUpperCase()}: ${reasons.join(", ")}, target=${targetPercent.toFixed(2)}%, stop=${stopPercent.toFixed(2)}% @ $${price.toFixed(0)}`,
    strength,
    suggestedMinHoldSeconds: regimeConfig.minHoldSeconds,
    stopPercent,
    targetPercent,
    hardMaxHoldSeconds: regimeConfig.maxHoldSeconds,
    trailingStop: regimeConfig.trailingStopEnabled ? {
      activationPercent: targetPercent * 0.5,
      trailPercent: targetPercent * 0.3,
    } : undefined,
    maxLossDollars: 30,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// PULLBACK ENTRY — Works in trending AND choppy regimes
// ═══════════════════════════════════════════════════════════════════════

function detectPullbackSignal(
  candles1m: Candle[],
  candles5m: Candle[],
  trend: TrendAssessment,
  regimeConfig: RegimeConfig,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });
  const price = candles1m[candles1m.length - 1].close;

  if (candles5m.length < 15) return noSignal("Insufficient 5m candles for pullback");

  const closes5m = candles5m.map(c => c.close);
  const ema21 = calcEMA(closes5m, 21);
  const ema50 = calcEMA(closes5m, Math.min(50, closes5m.length));

  const trendUp = ema21 > ema50;
  const trendDown = ema21 < ema50;

  if (!trendUp && !trendDown) {
    return noSignal(`No EMA trend for pullback (ema21=${ema21.toFixed(0)} ema50=${ema50.toFixed(0)}) @ $${price.toFixed(0)}`);
  }

  const side: "Long" | "Short" = trendUp ? "Long" : "Short";

  // Counter-trend blocking
  const counterTrend = briefDirective && (
    (briefDirective.bias === "long" && side === "Short") ||
    (briefDirective.bias === "short" && side === "Long")
  );
  if (counterTrend && (briefDirective!.regimeConfidence || 0) >= 0.6) {
    return noSignal(`${side} pullback blocked: counter-trend @ $${price.toFixed(0)}`);
  }

  // Price must be near EMA21
  const distFromEma21Pct = ((price - ema21) / ema21) * 100;

  if (side === "Long") {
    if (distFromEma21Pct > 0.20) return noSignal(`Long pullback: too far above EMA21 (${distFromEma21Pct.toFixed(3)}%) @ $${price.toFixed(0)}`);
    if (distFromEma21Pct < -0.60) return noSignal(`Long pullback: too far below EMA21 (${distFromEma21Pct.toFixed(3)}%) — trend break? @ $${price.toFixed(0)}`);
  } else {
    if (distFromEma21Pct < -0.20) return noSignal(`Short pullback: too far below EMA21 (${distFromEma21Pct.toFixed(3)}%) @ $${price.toFixed(0)}`);
    if (distFromEma21Pct > 0.60) return noSignal(`Short pullback: too far above EMA21 (${distFromEma21Pct.toFixed(3)}%) — trend break? @ $${price.toFixed(0)}`);
  }

  // Bounce candle confirmation
  const last1m = candles1m[candles1m.length - 1];
  const prev1m = candles1m.length > 1 ? candles1m[candles1m.length - 2] : null;

  const lastMove = last1m.close - last1m.open;
  const bouncingRight = (side === "Long" && lastMove > 0) || (side === "Short" && lastMove < 0);

  if (!bouncingRight) {
    return noSignal(`${side} pullback: no bounce candle (${lastMove > 0 ? "↑" : "↓"}) @ $${price.toFixed(0)}`);
  }

  const prevMove = prev1m ? (prev1m.close - prev1m.open) : 0;
  const wasPullingBack = (side === "Long" && prevMove < 0) || (side === "Short" && prevMove > 0);

  // RSI check
  if (side === "Long" && trend.rsi > 70) return noSignal(`Long pullback: RSI too high (${trend.rsi.toFixed(0)}) @ $${price.toFixed(0)}`);
  if (side === "Short" && trend.rsi < 30) return noSignal(`Short pullback: RSI too low (${trend.rsi.toFixed(0)}) @ $${price.toFixed(0)}`);

  // ─── STRENGTH ───
  let strength = 0.30;
  const reasons: string[] = [`dist_EMA21=${distFromEma21Pct.toFixed(3)}%`];

  // Trend gap strength
  const trendGap = Math.abs(((ema21 - ema50) / ema50) * 100);
  strength += Math.min(trendGap * 0.4, 0.15);
  if (trendGap > 0.1) reasons.push(`trendGap=${trendGap.toFixed(3)}%`);

  if (wasPullingBack) { strength += 0.10; reasons.push("pullback_confirmed"); }

  // Bounce quality
  const bounceRange = last1m.high - last1m.low;
  const bounceBody = Math.abs(lastMove);
  const bounceQuality = bounceRange > 0 ? bounceBody / bounceRange : 0;
  strength += bounceQuality * 0.10;

  // Researcher alignment
  if (briefDirective?.bias === (side === "Long" ? "long" : "short")) {
    strength += 0.12;
    reasons.push("bias_aligned");
  }

  // OB alignment
  if (orderbook && orderbook.strength > 0.2) {
    if ((orderbook.lean === "long" && side === "Long") || (orderbook.lean === "short" && side === "Short")) {
      strength += 0.08;
      reasons.push(`OB:${orderbook.ratio.toFixed(2)}`);
    }
  }

  strength = Math.max(0, Math.min(1.0, strength));

  // Use a slightly lower bar for pullbacks (high-probability pattern)
  const minStrength = Math.max(regimeConfig.minStrength - 0.05, 0.30);
  if (strength < minStrength) {
    return noSignal(`${side} pullback too weak (${strength.toFixed(2)} < ${minStrength}) @ $${price.toFixed(0)}`);
  }

  const stopPercent = Math.max(0.35, trend.atrPercent * regimeConfig.stopMultiplier);
  const targetPercent = Math.max(0.40, trend.atrPercent * regimeConfig.targetMultiplier * 0.8);

  reasons.push(`RSI=${trend.rsi.toFixed(0)}`);

  return {
    detected: true,
    side,
    mode: "swing_pullback",
    reason: `🔄 PULLBACK ${side.toUpperCase()}: ${reasons.join(", ")}, target=${targetPercent.toFixed(2)}%, stop=${stopPercent.toFixed(2)}% @ $${price.toFixed(0)}`,
    strength,
    suggestedMinHoldSeconds: regimeConfig.minHoldSeconds,
    stopPercent,
    targetPercent,
    hardMaxHoldSeconds: regimeConfig.maxHoldSeconds,
    trailingStop: regimeConfig.trailingStopEnabled ? {
      activationPercent: targetPercent * 0.5,
      trailPercent: targetPercent * 0.35,
    } : undefined,
    maxLossDollars: 30,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// DIVERGENCE PLAY — OB vs price trend
// ═══════════════════════════════════════════════════════════════════════

function detectDivergenceSignal(
  candles1m: Candle[],
  candles5m: Candle[],
  trend: TrendAssessment,
  regimeConfig: RegimeConfig,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });

  if (!orderbook || orderbook.strength < 0.5) {
    return noSignal("No strong OB for divergence");
  }

  const price = candles1m[candles1m.length - 1].close;

  const obSide: "Long" | "Short" | null =
    orderbook.lean === "long" ? "Long" : orderbook.lean === "short" ? "Short" : null;
  if (!obSide) return noSignal("OB neutral");

  const trendSide = trend.direction === "bullish" ? "Long" : trend.direction === "bearish" ? "Short" : null;

  // Need divergence
  if (!trendSide || obSide === trendSide) {
    return noSignal(`OB (${obSide}) agrees with trend (${trendSide}) — no divergence @ $${price.toFixed(0)}`);
  }

  const side = obSide;

  // Strong OB required
  const strongOB = orderbook.ratio > 2.0 || orderbook.ratio < 0.5;
  if (!strongOB) {
    return noSignal(`${side} divergence: OB not strong enough (ratio:${orderbook.ratio.toFixed(2)}) @ $${price.toFixed(0)}`);
  }

  // RSI extreme confirmation
  const rsiExtreme = (side === "Long" && trend.rsi < 35) || (side === "Short" && trend.rsi > 65);
  if (!rsiExtreme) {
    return noSignal(`${side} divergence: RSI not extreme (${trend.rsi.toFixed(0)}) @ $${price.toFixed(0)}`);
  }

  const bbExtreme = (side === "Long" && trend.bbands.percentB < 0.15) ||
                    (side === "Short" && trend.bbands.percentB > 0.85);

  // Rejection wick
  const lastCandle = candles1m[candles1m.length - 1];
  const body = Math.abs(lastCandle.close - lastCandle.open);
  const range = lastCandle.high - lastCandle.low;
  const hasRejection = range > 0 && body / range < 0.5;

  let strength = 0.30;
  const reasons: string[] = [`OB:${orderbook.ratio.toFixed(2)}/${orderbook.lean}`];

  strength += Math.min(orderbook.strength * 0.20, 0.20);
  if (rsiExtreme) { strength += 0.12; reasons.push(`RSI=${trend.rsi.toFixed(0)}`); }
  if (bbExtreme) { strength += 0.10; reasons.push(`BB%=${trend.bbands.percentB.toFixed(2)}`); }
  if (hasRejection) { strength += 0.12; reasons.push("rejection_wick"); }

  strength = Math.max(0, Math.min(1.0, strength));

  // Higher bar for divergence plays
  const minStrength = Math.max(regimeConfig.minStrength + 0.10, 0.50);
  if (strength < minStrength) {
    return noSignal(`${side} divergence too weak (${strength.toFixed(2)} < ${minStrength}) @ $${price.toFixed(0)}`);
  }

  const stopPercent = Math.max(0.40, trend.atrPercent * 0.6);
  const targetPercent = Math.max(0.50, trend.atrPercent * 1.2);

  return {
    detected: true,
    side,
    mode: "swing_divergence",
    reason: `📊 DIVERGENCE ${side.toUpperCase()}: ${reasons.join(", ")}, target=${targetPercent.toFixed(2)}%, stop=${stopPercent.toFixed(2)}% @ $${price.toFixed(0)}`,
    strength,
    suggestedMinHoldSeconds: regimeConfig.minHoldSeconds,
    stopPercent,
    targetPercent,
    hardMaxHoldSeconds: regimeConfig.maxHoldSeconds,
    trailingStop: {
      activationPercent: targetPercent * 0.5,
      trailPercent: targetPercent * 0.3,
    },
    maxLossDollars: 30,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN EXPORTED FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * detectMomentum — Primary entry signal detector.
 * v11.0: Now regime-adaptive. Composes signals based on current market regime.
 *
 * In HIGH_VOL_CHOP: Mean Reversion first, then pullbacks
 * In TRENDING: Trend following first, then pullbacks
 * In LOW_VOL: Mostly skip, only take very strong signals
 *
 * NO STABILITY GATE — trades immediately regardless of regime changes.
 * The regime config itself provides the appropriate caution level.
 */
export function detectMomentum(
  candles: Candle[],
  momentumThreshold: number = 0.05,
  maxChase: number = 0.4,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
): MomentumSignal {
  const noSignal: MomentumSignal = { detected: false, reason: "No signal" };

  if (candles.length < 20) {
    return { ...noSignal, reason: `Insufficient candles: ${candles.length} (need 20)` };
  }

  // Determine regime and configuration
  const regime = briefDirective?.regime || "unknown";
  const regimeConfig = getRegimeConfig(regime);

  // Assess trend using effective ATR (researcher data preferred)
  const trend = assessTrend(candles, briefDirective);

  // Aggregate to 5m candles
  const candles5m = aggregateCandles(candles, 5);

  const price = candles[candles.length - 1].close;

  // Log regime info
  const regimeInfo = `[${regime}→${regimeConfig.mode}] ATR=${trend.atrPercent.toFixed(2)}%(eff) localATR=${trend.localAtrPercent.toFixed(3)}%(1m)`;

  // If regime says WAIT and we don't have a super-strong setup, skip
  if (regimeConfig.mode === "wait") {
    // Still try but with very high bar (minStrength is already 0.70)
    const trendSig = detectTrendSignal(candles, candles5m, trend, regimeConfig, briefDirective, orderbook);
    if (trendSig.detected) return trendSig;
    return { ...noSignal, reason: `${regimeInfo} — waiting mode, no strong signal @ $${price.toFixed(0)}` };
  }

  // ─── MEAN REVERSION PRIORITY in chop regimes ───
  if (regimeConfig.mode === "mean_reversion") {
    // Try mean reversion first (primary)
    const mrSignal = detectMeanReversionSignal(candles, candles5m, trend, regimeConfig, briefDirective, orderbook);
    if (mrSignal.detected) return mrSignal;

    // Then pullbacks (secondary — still works in chop if there's a local trend)
    const pullbackSignal = detectPullbackSignal(candles, candles5m, trend, regimeConfig, briefDirective, orderbook);
    if (pullbackSignal.detected) return pullbackSignal;

    // Divergence (tertiary)
    const divSignal = detectDivergenceSignal(candles, candles5m, trend, regimeConfig, briefDirective, orderbook);
    if (divSignal.detected) return divSignal;

    return { ...noSignal, reason: `${regimeInfo} — MR mode, ${mrSignal.reason}` };
  }

  // ─── TREND FOLLOWING PRIORITY in trending regimes ───
  if (regimeConfig.mode === "trend_follow") {
    // Try trend following first (primary)
    const trendSignal = detectTrendSignal(candles, candles5m, trend, regimeConfig, briefDirective, orderbook);
    if (trendSignal.detected) return trendSignal;

    // Then pullbacks (secondary — highest probability entry)
    const pullbackSignal = detectPullbackSignal(candles, candles5m, trend, regimeConfig, briefDirective, orderbook);
    if (pullbackSignal.detected) return pullbackSignal;

    // Divergence (tertiary — counter-trend plays)
    const divSignal = detectDivergenceSignal(candles, candles5m, trend, regimeConfig, briefDirective, orderbook);
    if (divSignal.detected) return divSignal;

    // Mean reversion (last resort in trending — rare but possible at extremes)
    const mrSignal = detectMeanReversionSignal(candles, candles5m, trend, regimeConfig, briefDirective, orderbook);
    if (mrSignal.detected) return mrSignal;

    return { ...noSignal, reason: `${regimeInfo} — trend mode, ${trendSignal.reason}` };
  }

  return { ...noSignal, reason: `${regimeInfo} — unhandled mode @ $${price.toFixed(0)}` };
}

/**
 * detectMeanReversion — Standalone mean reversion detector.
 * v11.0: Enhanced with StochRSI, wider BB tolerance, researcher ATR.
 * Can be called directly by server.ts for explicit MR checks.
 */
export function detectMeanReversion(
  candles: Candle[],
  threshold: number = 0.3,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
): MomentumSignal {
  const noSignal: MomentumSignal = { detected: false, reason: "No mean reversion signal" };

  if (candles.length < 20) {
    return { ...noSignal, reason: `Insufficient candles: ${candles.length}` };
  }

  const regime = briefDirective?.regime || "unknown";
  const regimeConfig = getRegimeConfig(regime);
  const trend = assessTrend(candles, briefDirective);
  const candles5m = aggregateCandles(candles, 5);

  return detectMeanReversionSignal(candles, candles5m, trend, regimeConfig, briefDirective, orderbook);
}