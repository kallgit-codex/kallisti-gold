// KALLISTI GOLD v2.0 - Gold Futures Regime-Adaptive Strategy
// v2.0: COMPLETE REWRITE for gold futures on Coinbase CFM
//
// CRITICAL FIXES FROM v1.0:
//   1. ATR threshold was 0.25% hardcoded — gold 1m ATR is 0.03-0.10%, blocked ALL trades
//   2. Now uses config.strategy.minVolatilityPercent (0.02%) instead of hardcoded values
//   3. ATR scaling properly handles gold's lower volatility vs BTC
//   4. Session awareness: London/NY = aggressive, Asian = conservative, maintenance = no trade
//   5. Safe-haven bias: BTC crash / risk-off detection → gold bullish bias
//   6. Gold-specific EMA mean reversion (gold loves bouncing off 9/21 EMAs intraday)
//   7. Proper ATR calculation per [wikipedia.org](https://en.wikipedia.org/wiki/Average_true_range)
//   8. ATR-based stops per [paperswithbacktest.com](https://paperswithbacktest.com/wiki/average-true-range-trading-strategy)
//   9. MA + RSI combo per [mudrex.com](https://mudrex.com/learn/gold-futures-swing-trading-ma-rsi-strategy/)
//
// GOLD CHARACTERISTICS:
//   - Daily range: 0.5-1.2% (vs BTC 2-5%)
//   - 1m ATR: typically 0.03-0.10% — MUCH lower than BTC
//   - Hourly ATR: typically 0.15-0.60%
//   - Trends: cleaner, session-driven (London open, NY overlap)
//   - Mean reverts to 9/21 EMA intraday
//   - Safe haven: rallies when equities/crypto crash
//   - Maintenance break: 22:00-23:00 UTC daily
//
// STRATEGY MODES:
//   A. HIGH_VOL_CHOP → Mean Reversion (fade BB extremes, tight targets)
//   B. TRENDING → Trend Following + EMA Pullbacks (ride the move)
//   C. LOW_VOL → EMA Bounce only (tight, high-probability)
//
// SESSIONS (affects aggression):
//   - Asian (23:00-03:00 UTC): low vol, conservative, MR only
//   - London (03:00-08:00 UTC): structural moves, moderate
//   - London/NY Overlap (13:00-17:00 UTC): peak vol, aggressive
//   - NY (08:00-20:00 UTC): news-driven, moderate-aggressive
//   - Pre-maintenance (20:00-22:00 UTC): wind down, no new trades after 21:30
//   - Maintenance (22:00-23:00 UTC): NO TRADING

import { config } from "../config";

// ═══════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════

export interface Candle {
  time: number;
  open: number;
  high: number;
  close: number;
  low: number;
  volume: number;
}

export interface MomentumSignal {
  detected: boolean;
  reason?: string;
  strength?: number;
  side?: "Long" | "Short";
  mode?: "momentum" | "mean_reversion" | "swing_trend" | "swing_divergence" | "swing_pullback" | "ema_bounce" | "session_breakout";
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
    atrPercent: number;
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
  safeHaven?: {
    btcDrawdownPercent?: number;
    riskOff?: boolean;
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
// SESSION AWARENESS — Gold is heavily session-driven
// ═══════════════════════════════════════════════════════════════════════

type GoldSession = "asian" | "london" | "london_ny_overlap" | "new_york" | "pre_maintenance" | "maintenance";

interface SessionConfig {
  name: string;
  aggressionMultiplier: number;  // Scales signal strength requirements
  preferredMode: "mean_reversion" | "trend_follow" | "both" | "none";
  maxTradesPerHour: number;
  minStrengthOverride?: number;  // Override regime minStrength
}

const SESSION_CONFIGS: Record<GoldSession, SessionConfig> = {
  asian: {
    name: "Asian (Low Vol)",
    aggressionMultiplier: 0.6,
    preferredMode: "mean_reversion",
    maxTradesPerHour: 2,
    minStrengthOverride: 0.50,
  },
  london: {
    name: "London Open",
    aggressionMultiplier: 0.9,
    preferredMode: "both",
    maxTradesPerHour: 3,
  },
  london_ny_overlap: {
    name: "London/NY Overlap (Peak)",
    aggressionMultiplier: 1.2,
    preferredMode: "both",
    maxTradesPerHour: 4,
  },
  new_york: {
    name: "New York",
    aggressionMultiplier: 1.0,
    preferredMode: "both",
    maxTradesPerHour: 3,
  },
  pre_maintenance: {
    name: "Pre-Maintenance Wind Down",
    aggressionMultiplier: 0.4,
    preferredMode: "mean_reversion",
    maxTradesPerHour: 1,
    minStrengthOverride: 0.60,
  },
  maintenance: {
    name: "Maintenance Break",
    aggressionMultiplier: 0,
    preferredMode: "none",
    maxTradesPerHour: 0,
  },
};

function getCurrentSession(): { session: GoldSession; config: SessionConfig } {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const timeDecimal = utcHour + utcMinute / 60;

  let session: GoldSession;

  if (timeDecimal >= 22 && timeDecimal < 23) {
    session = "maintenance";
  } else if (timeDecimal >= 21.5 && timeDecimal < 22) {
    session = "pre_maintenance";
  } else if (timeDecimal >= 20 && timeDecimal < 21.5) {
    session = "pre_maintenance";
  } else if (timeDecimal >= 23 || timeDecimal < 3) {
    session = "asian";
  } else if (timeDecimal >= 3 && timeDecimal < 8) {
    session = "london";
  } else if (timeDecimal >= 13 && timeDecimal < 17) {
    session = "london_ny_overlap";
  } else if (timeDecimal >= 8 && timeDecimal < 20) {
    session = "new_york";
  } else {
    session = "asian";
  }

  return { session, config: SESSION_CONFIGS[session] };
}

// ═══════════════════════════════════════════════════════════════════════
// REGIME CLASSIFICATION — Tuned for gold's lower volatility
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
  high_vol_chop: {
    mode: "mean_reversion",
    minStrength: 0.35,
    stopMultiplier: 1.2,       // Wider stops for gold — noise is proportionally larger
    targetMultiplier: 0.8,     // Take profits at 0.8x ATR
    minHoldSeconds: 180,       // 3 min minimum
    maxHoldSeconds: 2400,      // 40 min max in chop
    trailingStopEnabled: false,
  },
  trending: {
    mode: "trend_follow",
    minStrength: 0.30,
    stopMultiplier: 1.0,
    targetMultiplier: 2.0,     // Let gold trends run — they're cleaner than BTC
    minHoldSeconds: 300,       // 5 min minimum
    maxHoldSeconds: 5400,      // 90 min max — gold trends last longer
    trailingStopEnabled: true,
  },
  low_vol: {
    mode: "mean_reversion",    // Changed from "wait" — gold low vol still tradeable with EMA bounces
    minStrength: 0.45,
    stopMultiplier: 1.5,       // Tight stops relative to small moves
    targetMultiplier: 1.0,
    minHoldSeconds: 120,
    maxHoldSeconds: 1800,
    trailingStopEnabled: false,
  },
  unknown: {
    mode: "trend_follow",
    minStrength: 0.40,
    stopMultiplier: 1.0,
    targetMultiplier: 1.5,
    minHoldSeconds: 180,
    maxHoldSeconds: 3600,
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
// BRIEF PARSER — with volatility & safe-haven extraction
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

    // Extract volatility data from researcher brief
    const volatility: BriefDirective["volatility"] = {} as any;
    let hasVolatility = false;

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

    if (!volatility!.atrPercent && trendData.atrPercent) {
      volatility!.atrPercent = trendData.atrPercent;
      hasVolatility = true;
    }

    // Extract safe-haven signals
    let safeHaven: BriefDirective["safeHaven"] | undefined;
    const shSources = [brief.safe_haven, brief.safeHaven, brief.macro, brief];
    for (const src of shSources) {
      if (!src || typeof src !== "object") continue;
      const btcFields = ["btc_drawdown", "btcDrawdown", "btc_drawdown_percent", "btcDrawdownPercent"];
      for (const f of btcFields) {
        if (typeof src[f] === "number") {
          safeHaven = { btcDrawdownPercent: src[f], riskOff: src[f] < -5 };
          break;
        }
      }
      if (src.risk_off !== undefined || src.riskOff !== undefined) {
        safeHaven = safeHaven || {};
        safeHaven.riskOff = Boolean(src.risk_off || src.riskOff);
      }
      if (safeHaven) break;
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
      safeHaven,
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
// TECHNICAL INDICATORS — Gold-tuned
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

// ATR calculation per Wilder's smoothed moving average method
// [wikipedia.org](https://en.wikipedia.org/wiki/Average_true_range)
function calcATR(candles: Candle[], period: number = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    // True Range = max(high - low, |high - prevClose|, |low - prevClose|)
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
    trs.push(tr);
  }
  if (trs.length === 0) return 0;

  // Use Wilder's smoothing: ATR_t = (ATR_{t-1} * (n-1) + TR_t) / n
  const n = Math.min(period, trs.length);
  let atr = trs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < trs.length; i++) {
    atr = (atr * (n - 1) + trs[i]) / n;
  }
  return atr;
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
  const width = middle > 0 ? ((upper - lower) / middle) * 100 : 0;
  const currentPrice = closes[closes.length - 1];
  const percentB = upper !== lower ? (currentPrice - lower) / (upper - lower) : 0.5;

  return { upper, middle, lower, width, percentB };
}

function calcStochRSI(closes: number[], rsiPeriod = 14, stochPeriod = 14): number {
  if (closes.length < rsiPeriod + stochPeriod + 1) return 50;

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

// VWAP approximation from candle data
function calcVWAP(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  let cumulativeTPV = 0;
  let cumulativeVol = 0;
  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumulativeTPV += typicalPrice * c.volume;
    cumulativeVol += c.volume;
  }
  return cumulativeVol > 0 ? cumulativeTPV / cumulativeVol : candles[candles.length - 1].close;
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
// EFFECTIVE ATR — Gold-calibrated, multi-source
// Uses researcher hourly ATR when available, properly scales local 1m ATR
// Per [paperswithbacktest.com](https://paperswithbacktest.com/wiki/average-true-range-applications)
// ═══════════════════════════════════════════════════════════════════════

function getEffectiveATRPercent(
  candles: Candle[],
  briefDirective?: BriefDirective,
): { hourly: number; local1m: number; source: string } {
  let hourly = 0;
  let source = "default";

  // PRIORITY 1: Researcher's ATR (hourly, most accurate)
  if (briefDirective?.volatility?.atrPercent && briefDirective.volatility.atrPercent > 0) {
    hourly = briefDirective.volatility.atrPercent;
    source = "researcher_atr";
  }

  // PRIORITY 2: ATR from trend data
  if (!hourly && briefDirective?.trendData?.atrPercent && briefDirective.trendData.atrPercent > 0) {
    hourly = briefDirective.trendData.atrPercent;
    source = "trend_data_atr";
  }

  // PRIORITY 3: Estimate from 24h range (range ≈ 4-5x hourly ATR for gold)
  if (!hourly && briefDirective?.volatility?.range24hPercent && briefDirective.volatility.range24hPercent > 0) {
    hourly = briefDirective.volatility.range24hPercent / 4.5;
    source = "range_24h_derived";
  }

  // Calculate local 1m ATR regardless (for comparison and fallback)
  let local1m = 0;
  if (candles.length >= 5) {
    const localATR = calcATR(candles, Math.min(14, candles.length - 1));
    const price = candles[candles.length - 1].close;
    if (price > 0 && localATR > 0) {
      local1m = (localATR / price) * 100;
    }
  }

  // PRIORITY 4: Scale local 1m ATR to hourly
  // For gold: 1m ATR ≈ 0.03-0.10%, hourly ≈ 0.15-0.60%
  // Scaling factor: sqrt(60) ≈ 7.75 for random walk, but gold mean-reverts
  // so use a lower factor of ~5
  if (!hourly && local1m > 0) {
    hourly = local1m * 5.0;
    source = "local_1m_scaled";
  }

  // PRIORITY 5: Default for gold
  if (!hourly) {
    hourly = 0.35;  // Typical gold hourly ATR
    source = "gold_default";
  }

  return { hourly, local1m, source };
}

// ═══════════════════════════════════════════════════════════════════════
// SAFE HAVEN DETECTION — BTC crash = gold bullish
// ═══════════════════════════════════════════════════════════════════════

interface SafeHavenSignal {
  active: boolean;
  bias: "long" | "neutral";
  strength: number;  // 0-1
  reason: string;
}

function detectSafeHavenBias(briefDirective?: BriefDirective): SafeHavenSignal {
  const neutral: SafeHavenSignal = { active: false, bias: "neutral", strength: 0, reason: "no signal" };

  if (!briefDirective) return neutral;

  let strength = 0;
  const reasons: string[] = [];

  // Direct safe-haven data from researcher
  if (briefDirective.safeHaven?.riskOff) {
    strength += 0.30;
    reasons.push("risk_off_flag");
  }

  if (briefDirective.safeHaven?.btcDrawdownPercent) {
    const dd = briefDirective.safeHaven.btcDrawdownPercent;
    if (dd < -3) {
      strength += Math.min(Math.abs(dd) * 0.04, 0.40);
      reasons.push(`BTC_dd=${dd.toFixed(1)}%`);
    }
  }

  // High volatility in crypto often means risk-off → gold bid
  const regime = briefDirective.regime || "";
  if (regime.includes("high_vol")) {
    strength += 0.10;
    reasons.push("high_vol_regime");
  }

  // If researcher explicitly says long bias with high confidence, amplify
  if (briefDirective.bias === "long" && briefDirective.regimeConfidence > 0.7) {
    strength += 0.15;
    reasons.push("researcher_long_bias");
  }

  if (strength >= 0.20) {
    return {
      active: true,
      bias: "long",
      strength: Math.min(strength, 1.0),
      reason: `🏆 Safe-Haven: ${reasons.join(", ")}`,
    };
  }

  return neutral;
}

// ═══════════════════════════════════════════════════════════════════════
// TREND ASSESSMENT — Gold-tuned
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
  atrPercent: number;             // Hourly-scale effective ATR
  localAtrPercent: number;        // Raw local 1m ATR
  atrSource: string;
  bbands: { upper: number; middle: number; lower: number; width: number; percentB: number };
  vwap: number;
  priceVsEma9Pct: number;
  priceVsEma21Pct: number;
  priceVsEma50Pct: number;
  priceVsVwapPct: number;
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

  const atrData = getEffectiveATRPercent(candles, briefDirective);

  const bbands = calcBollingerBands(closes, 20, 2);
  const vwap = calcVWAP(candles);

  const priceVsEma9Pct = ema9 > 0 ? ((currentPrice - ema9) / ema9) * 100 : 0;
  const priceVsEma21Pct = ema21 > 0 ? ((currentPrice - ema21) / ema21) * 100 : 0;
  const priceVsEma50Pct = ema50 > 0 ? ((currentPrice - ema50) / ema50) * 100 : 0;
  const priceVsVwapPct = vwap > 0 ? ((currentPrice - vwap) / vwap) * 100 : 0;

  const isMacdCrossUp = macd.histogram > 0 && macd.prevHistogram <= 0;
  const isMacdCrossDown = macd.histogram < 0 && macd.prevHistogram >= 0;
  const isHistogramGrowing = Math.abs(macd.histogram) > Math.abs(macd.prevHistogram);

  // Gold trend scoring — per [mudrex.com](https://mudrex.com/learn/gold-futures-swing-trading-ma-rsi-strategy/)
  // Uses EMA stack, MACD, RSI with gold-appropriate thresholds
  let score = 0;
  if (ema9 > ema21) score += 1; else score -= 1;
  if (ema21 > ema50) score += 1; else score -= 1;
  if (currentPrice > ema9) score += 0.5; else score -= 0.5;
  if (currentPrice > ema21) score += 0.5; else score -= 0.5;
  if (currentPrice > vwap) score += 0.3; else score -= 0.3;
  if (macd.histogram > 0) score += 0.5; else score -= 0.5;
  if (isHistogramGrowing && macd.histogram > 0) score += 0.5;
  if (isHistogramGrowing && macd.histogram < 0) score -= 0.5;
  // Gold RSI: use 40-60 neutral zone per mudrex strategy
  if (rsi > 55) score += 0.5; else if (rsi < 45) score -= 0.5;

  let direction: "bullish" | "bearish" | "neutral" = "neutral";
  if (score >= 1.5) direction = "bullish";
  else if (score <= -1.5) direction = "bearish";

  const strength = Math.min(Math.abs(score) / 5, 1.0);

  return {
    direction, strength, ema9, ema21, ema50, rsi, stochRSI, macd,
    atrPercent: atrData.hourly,
    localAtrPercent: atrData.local1m,
    atrSource: atrData.source,
    bbands, vwap,
    priceVsEma9Pct, priceVsEma21Pct, priceVsEma50Pct, priceVsVwapPct,
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
// GOLD-SPECIFIC: EMA BOUNCE SIGNAL
// Gold mean-reverts beautifully to 9 and 21 EMAs intraday
// This is the bread-and-butter gold scalp
// ═══════════════════════════════════════════════════════════════════════

function detectEMABounceSignal(
  candles1m: Candle[],
  trend: TrendAssessment,
  regimeConfig: RegimeConfig,
  sessionConfig: SessionConfig,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
  safeHaven?: SafeHavenSignal,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });
  const price = candles1m[candles1m.length - 1].close;

  if (candles1m.length < 15) return noSignal("Insufficient candles for EMA bounce");

  // Gold loves bouncing off EMA9 in trends, EMA21 for deeper pullbacks
  const distEma9 = trend.priceVsEma9Pct;
  const distEma21 = trend.priceVsEma21Pct;

  // Need a clear EMA stack direction
  const emaStackUp = trend.ema9 > trend.ema21 && trend.ema21 > trend.ema50;
  const emaStackDown = trend.ema9 < trend.ema21 && trend.ema21 < trend.ema50;

  if (!emaStackUp && !emaStackDown) {
    return noSignal(`EMA bounce: no clear stack (9=${trend.ema9.toFixed(1)} 21=${trend.ema21.toFixed(1)} 50=${trend.ema50.toFixed(1)}) @ $${price.toFixed(1)}`);
  }

  const side: "Long" | "Short" = emaStackUp ? "Long" : "Short";

  // Gold-specific EMA proximity thresholds (in %)
  // Gold 1m candles: EMA9 touch ≈ 0.01-0.04%, EMA21 touch ≈ 0.03-0.08%
  const touchingEma9 = Math.abs(distEma9) < 0.03;
  const touchingEma21 = Math.abs(distEma21) < 0.06;
  const pulledBackToEma9 = side === "Long" ? (distEma9 > -0.04 && distEma9 < 0.01) :
                                              (distEma9 < 0.04 && distEma9 > -0.01);
  const pulledBackToEma21 = side === "Long" ? (distEma21 > -0.07 && distEma21 < 0.02) :
                                               (distEma21 < 0.07 && distEma21 > -0.02);

  if (!touchingEma9 && !touchingEma21 && !pulledBackToEma9 && !pulledBackToEma21) {
    return noSignal(`EMA bounce: price too far from EMAs (d9=${distEma9.toFixed(3)}% d21=${distEma21.toFixed(3)}%) @ $${price.toFixed(1)}`);
  }

  // Bounce confirmation: last candle should show direction change
  const last = candles1m[candles1m.length - 1];
  const prev = candles1m[candles1m.length - 2];
  const lastMove = last.close - last.open;
  const prevMove = prev.close - prev.open;

  const bouncing = (side === "Long" && lastMove > 0) || (side === "Short" && lastMove < 0);
  const wasPullingBack = (side === "Long" && prevMove < 0) || (side === "Short" && prevMove > 0);

  if (!bouncing) {
    return noSignal(`EMA bounce ${side}: no bounce candle yet @ $${price.toFixed(1)}`);
  }

  // RSI: should be in the 40-60 zone for pullback entry (per mudrex strategy)
  // Or at least not overbought/oversold
  if (side === "Long" && trend.rsi > 70) return noSignal(`EMA bounce Long: RSI too high (${trend.rsi.toFixed(0)}) @ $${price.toFixed(1)}`);
  if (side === "Short" && trend.rsi < 30) return noSignal(`EMA bounce Short: RSI too low (${trend.rsi.toFixed(0)}) @ $${price.toFixed(1)}`);

  // ─── STRENGTH SCORING ───
  let strength = 0.25;
  const reasons: string[] = [];

  // EMA proximity
  if (touchingEma9 || pulledBackToEma9) {
    strength += 0.12;
    reasons.push(`EMA9_touch(${distEma9.toFixed(3)}%)`);
  }
  if (touchingEma21 || pulledBackToEma21) {
    strength += 0.15;
    reasons.push(`EMA21_touch(${distEma21.toFixed(3)}%)`);
  }

  // Was pulling back then bounced (classic pattern)
  if (wasPullingBack) {
    strength += 0.10;
    reasons.push("pullback_bounce");
  }

  // RSI in sweet zone (40-60)
  if (trend.rsi >= 40 && trend.rsi <= 60) {
    strength += 0.08;
    reasons.push(`RSI_sweet(${trend.rsi.toFixed(0)})`);
  }

  // VWAP alignment
  if ((side === "Long" && price > trend.vwap) || (side === "Short" && price < trend.vwap)) {
    strength += 0.06;
    reasons.push("VWAP_aligned");
  }

  // Safe haven bonus
  if (safeHaven?.active && side === "Long") {
    strength += safeHaven.strength * 0.15;
    reasons.push("safe_haven_boost");
  }

  // Researcher alignment
  if (briefDirective?.bias === (side === "Long" ? "long" : "short")) {
    strength += 0.10;
    reasons.push("bias_aligned");
  }

  // OB alignment
  if (orderbook && orderbook.strength > 0.2) {
    if ((orderbook.lean === "long" && side === "Long") || (orderbook.lean === "short" && side === "Short")) {
      strength += 0.08 * orderbook.strength;
      reasons.push(`OB:${orderbook.ratio.toFixed(2)}`);
    }
  }

  // Session multiplier
  strength *= sessionConfig.aggressionMultiplier;

  // Counter-trend penalty
  if (briefDirective?.bias && briefDirective.bias !== "neutral" &&
      briefDirective.bias !== (side === "Long" ? "long" : "short") &&
      briefDirective.regimeConfidence > 0.6) {
    strength *= 0.6;
    reasons.push("counter_bias");
  }

  strength = Math.max(0, Math.min(1.0, strength));

  const minStr = sessionConfig.minStrengthOverride || regimeConfig.minStrength;
  if (strength < minStr) {
    return noSignal(`EMA bounce ${side}: too weak (${strength.toFixed(2)} < ${minStr.toFixed(2)}) [${reasons.join(", ")}] @ $${price.toFixed(1)}`);
  }

  // ATR-based stop and target — gold-tuned
  // [paperswithbacktest.com](https://paperswithbacktest.com/wiki/average-true-range-trading-strategy)
  const atr = trend.atrPercent;
  const stopPercent = Math.max(0.08, atr * 0.4);   // Tighter for EMA bounces
  const targetPercent = Math.max(0.10, atr * 0.6);  // Quick targets

  reasons.push(`ATR=${atr.toFixed(3)}%(${trend.atrSource})`);

  return {
    detected: true,
    side,
    mode: "ema_bounce",
    reason: `📏 EMA_BOUNCE ${side.toUpperCase()}: ${reasons.join(", ")}, target=${targetPercent.toFixed(3)}%, stop=${stopPercent.toFixed(3)}% @ $${price.toFixed(1)}`,
    strength,
    suggestedMinHoldSeconds: Math.max(120, regimeConfig.minHoldSeconds),
    stopPercent,
    targetPercent,
    hardMaxHoldSeconds: regimeConfig.maxHoldSeconds,
    trailingStop: {
      activationPercent: targetPercent * 0.6,
      trailPercent: targetPercent * 0.4,
    },
    maxLossDollars: 25,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MEAN REVERSION SIGNAL — For chop regimes, fade BB/StochRSI extremes
// ═══════════════════════════════════════════════════════════════════════

function detectMeanReversionSignal(
  candles1m: Candle[],
  candles5m: Candle[],
  trend: TrendAssessment,
  regimeConfig: RegimeConfig,
  sessionConfig: SessionConfig,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
  safeHaven?: SafeHavenSignal,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });
  const price = candles1m[candles1m.length - 1].close;

  if (candles5m.length < 8) return noSignal("Insufficient 5m candles for MR");

  const closes5m = candles5m.map(c => c.close);
  const bb5m = calcBollingerBands(closes5m, 20, 2);
  const rsi5m = calcRSI(closes5m, 14);
  const stochRSI = trend.stochRSI;

  // *** CRITICAL FIX: Use config-based minimum volatility, NOT hardcoded ***
  // Gold 1m ATR is typically 0.03-0.10%, config says 0.02% minimum
  // The old code had 0.30% which BLOCKED ALL GOLD TRADES
  const minVol = config.strategy.minVolatilityPercent || 0.02;
  if (trend.localAtrPercent < minVol && trend.atrPercent < minVol) {
    return noSignal(`MR: ATR below config minimum (local=${trend.localAtrPercent.toFixed(4)}%, hourly=${trend.atrPercent.toFixed(3)}%, min=${minVol}%) @ $${price.toFixed(1)}`);
  }

  // ─── OVERSOLD LONG ───
  const oversold = stochRSI < 15 || (stochRSI < 25 && rsi5m < 38);
  const belowLowerBand = bb5m.percentB < 0.10;
  const nearLowerBand = bb5m.percentB < 0.20;

  // ─── OVERBOUGHT SHORT ───
  const overbought = stochRSI > 85 || (stochRSI > 75 && rsi5m > 62);
  const aboveUpperBand = bb5m.percentB > 0.90;
  const nearUpperBand = bb5m.percentB > 0.80;

  // Directional extension check
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

  // Gold-specific: lower thresholds for "extended" moves
  const extendedDown = downCandles >= 3 && totalMovePct < -0.06;
  const extendedUp = upCandles >= 3 && totalMovePct > 0.06;

  // Volume exhaustion
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

    if (extendedDown) { strength += 0.12; reasons.push(`extended↓(${downCandles}/${lookback})`); }
    if (volDecreasing) { strength += 0.08; reasons.push("vol_exhaust"); }
    if (stochRSI < 10) { strength += 0.10; reasons.push("deep_oversold"); }

    // VWAP below = extra confirmation for long MR
    if (price < trend.vwap) { strength += 0.06; reasons.push("below_VWAP"); }

    // Safe haven boost for longs
    if (safeHaven?.active) {
      strength += safeHaven.strength * 0.12;
      reasons.push("safe_haven");
    }

    if (orderbook && orderbook.lean === "long" && orderbook.strength > 0.2) {
      strength += 0.10 * orderbook.strength;
      reasons.push(`OB_bid:${orderbook.ratio.toFixed(2)}`);
    }

    if (briefDirective?.bias === "long") {
      strength += 0.10;
      reasons.push("bias_aligned");
    }

    if (briefDirective?.bias === "short" && (briefDirective.regimeConfidence || 0) > 0.7) {
      strength -= 0.12;
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

    if (extendedUp) { strength += 0.12; reasons.push(`extended↑(${upCandles}/${lookback})`); }
    if (volDecreasing) { strength += 0.08; reasons.push("vol_exhaust"); }
    if (stochRSI > 90) { strength += 0.10; reasons.push("deep_overbought"); }

    if (price > trend.vwap) { strength += 0.06; reasons.push("above_VWAP"); }

    // Safe haven: penalize shorts if risk-off
    if (safeHaven?.active) {
      strength -= safeHaven.strength * 0.15;
      reasons.push("safe_haven_short_penalty");
    }

    if (orderbook && orderbook.lean === "short" && orderbook.strength > 0.2) {
      strength += 0.10 * orderbook.strength;
      reasons.push(`OB_ask:${orderbook.ratio.toFixed(2)}`);
    }

    if (briefDirective?.bias === "short") {
      strength += 0.10;
      reasons.push("bias_aligned");
    }

    if (briefDirective?.bias === "long" && (briefDirective.regimeConfidence || 0) > 0.7) {
      strength -= 0.12;
      reasons.push("bias_opposed");
    }
  }

  if (!side) {
    return noSignal(`MR: no extreme (stochRSI=${stochRSI.toFixed(0)}, BB%=${bb5m.percentB.toFixed(2)}, RSI5m=${rsi5m.toFixed(0)}) @ $${price.toFixed(1)}`);
  }

  // Don't fade moves that are TOO large — could be breakout
  // Gold-tuned: lower threshold than BTC
  const maxFadeMove = trend.atrPercent * 1.5;
  if (Math.abs(totalMovePct) > maxFadeMove && maxFadeMove > 0.05) {
    return noSignal(`MR: move too large to fade (${Math.abs(totalMovePct).toFixed(3)}% > ${maxFadeMove.toFixed(3)}% limit) @ $${price.toFixed(1)}`);
  }

  // Session scaling
  strength *= sessionConfig.aggressionMultiplier;
  strength = Math.max(0, Math.min(1.0, strength));

  const minStr = sessionConfig.minStrengthOverride || regimeConfig.minStrength;
  if (strength < minStr) {
    return noSignal(`MR ${side}: too weak (${strength.toFixed(2)} < ${minStr.toFixed(2)}) @ $${price.toFixed(1)}`);
  }

  // ATR-based stop and target
  const stopPercent = Math.max(0.06, trend.atrPercent * regimeConfig.stopMultiplier);
  const targetPercent = Math.max(0.05, trend.atrPercent * regimeConfig.targetMultiplier);

  return {
    detected: true,
    side,
    mode: "mean_reversion",
    reason: `🔄 MR ${side.toUpperCase()}: ${reasons.join(", ")}, ATR=${trend.atrPercent.toFixed(3)}%(${trend.atrSource}), target=${targetPercent.toFixed(3)}%, stop=${stopPercent.toFixed(3)}% @ $${price.toFixed(1)}`,
    strength,
    suggestedMinHoldSeconds: regimeConfig.minHoldSeconds,
    stopPercent,
    targetPercent,
    hardMaxHoldSeconds: regimeConfig.maxHoldSeconds,
    trailingStop: regimeConfig.trailingStopEnabled ? {
      activationPercent: targetPercent * 0.6,
      trailPercent: targetPercent * 0.4,
    } : undefined,
    maxLossDollars: 25,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// TREND FOLLOWING SIGNAL — For trending regimes, ride gold's clean trends
// ═══════════════════════════════════════════════════════════════════════

function detectTrendSignal(
  candles1m: Candle[],
  candles5m: Candle[],
  trend: TrendAssessment,
  regimeConfig: RegimeConfig,
  sessionConfig: SessionConfig,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
  safeHaven?: SafeHavenSignal,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });
  const price = candles1m[candles1m.length - 1].close;

  if (candles5m.length < 10) return noSignal("Insufficient 5m candles for trend");

  if (trend.direction === "neutral") {
    return noSignal(`Trend neutral (str:${trend.strength.toFixed(2)}) @ $${price.toFixed(1)}`);
  }

  // *** CRITICAL FIX: Use config minimum, not hardcoded 0.25% ***
  const minVol = config.strategy.minVolatilityPercent || 0.02;
  if (trend.localAtrPercent < minVol && trend.atrPercent < minVol) {
    return noSignal(`Trend: ATR below minimum (${trend.atrPercent.toFixed(3)}%) @ $${price.toFixed(1)}`);
  }

  if (trend.atrPercent > 3.0) {
    return noSignal(`Trend: ATR too high for gold (${trend.atrPercent.toFixed(2)}%) — chaos @ $${price.toFixed(1)}`);
  }

  const side: "Long" | "Short" = trend.direction === "bullish" ? "Long" : "Short";

  // Counter-trend blocking
  const counterTrend = briefDirective && (
    (briefDirective.bias === "long" && side === "Short") ||
    (briefDirective.bias === "short" && side === "Long")
  );
  if (counterTrend && (briefDirective!.regimeConfidence || 0) >= 0.7) {
    return noSignal(`🚫 ${side} blocked: counter-trend (conf:${(briefDirective!.regimeConfidence || 0).toFixed(2)}) @ $${price.toFixed(1)}`);
  }

  // MACD alignment
  const macdAligned = (side === "Long" && trend.macd.histogram > 0) ||
                      (side === "Short" && trend.macd.histogram < 0);
  if (!macdAligned) {
    return noSignal(`${side} trend but MACD opposes (hist:${trend.macd.histogram.toFixed(4)}) @ $${price.toFixed(1)}`);
  }

  // RSI: don't chase extremes — gold uses 30/70 for trend following
  if (side === "Long" && trend.rsi > 72) {
    return noSignal(`Long trend but RSI overbought (${trend.rsi.toFixed(0)}) @ $${price.toFixed(1)}`);
  }
  if (side === "Short" && trend.rsi < 28) {
    return noSignal(`Short trend but RSI oversold (${trend.rsi.toFixed(0)}) @ $${price.toFixed(1)}`);
  }

  // Position in range quality
  const posRange = positionInRange(candles5m, 20);
  const posQuality = side === "Long" ? (1.0 - posRange.position) : posRange.position;

  if (posQuality < 0.10) {
    return noSignal(`${side} trend but extreme range position (${posRange.position.toFixed(2)}) @ $${price.toFixed(1)}`);
  }

  // ─── STRENGTH SCORING ───
  let strength = 0;
  const reasons: string[] = [];

  // Trend strength (0-0.25)
  strength += trend.strength * 0.25;
  reasons.push(`trend=${trend.direction}(${trend.strength.toFixed(2)})`);

  // MACD momentum growing (0-0.15)
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

  // Position quality (0-0.10)
  strength += posQuality * 0.10;

  // VWAP alignment (0-0.08)
  if ((side === "Long" && price > trend.vwap) || (side === "Short" && price < trend.vwap)) {
    strength += 0.08;
    reasons.push("VWAP_aligned");
  }

  // Safe haven boost for longs
  if (safeHaven?.active && side === "Long") {
    strength += safeHaven.strength * 0.15;
    reasons.push("safe_haven");
  }
  // Safe haven penalizes shorts
  if (safeHaven?.active && side === "Short") {
    strength -= safeHaven.strength * 0.20;
    reasons.push("safe_haven_penalty");
  }

  // Researcher alignment (0-0.12)
  const researcherAligned = briefDirective &&
    ((briefDirective.bias === "long" && side === "Long") ||
     (briefDirective.bias === "short" && side === "Short"));
  if (researcherAligned) {
    strength += 0.12 * (briefDirective!.regimeConfidence || 0.5);
    reasons.push("bias_aligned");
  }

  // OB alignment (0-0.08)
  if (orderbook && orderbook.strength > 0.2) {
    if ((orderbook.lean === "long" && side === "Long") ||
        (orderbook.lean === "short" && side === "Short")) {
      strength += 0.08 * orderbook.strength;
      reasons.push(`OB:${orderbook.ratio.toFixed(2)}`);
    }
  }

  // Volume confirmation
  const recentVols = candles5m.slice(-5).map(c => c.volume);
  const avgVol = recentVols.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, recentVols.length - 1);
  const currentVol = recentVols[recentVols.length - 1] || 0;
  const volRatio = avgVol > 0 ? currentVol / avgVol : 1;
  if (volRatio > 1.5) { strength += 0.05; reasons.push(`vol=${volRatio.toFixed(1)}x`); }
  if (volRatio < 0.3) { strength -= 0.08; }

  // Counter-trend penalty
  if (counterTrend) { strength -= 0.15; reasons.push("counter_trend"); }

  // Session scaling
  strength *= sessionConfig.aggressionMultiplier;
  strength = Math.max(0, Math.min(1.0, strength));

  const minStr = sessionConfig.minStrengthOverride || regimeConfig.minStrength;
  if (strength < minStr) {
    return noSignal(`${side} trend too weak (${strength.toFixed(2)} < ${minStr.toFixed(2)}) [${reasons.join(", ")}] @ $${price.toFixed(1)}`);
  }

  // ATR-based stops — gold trends are cleaner, so wider targets
  const stopPercent = Math.max(0.08, trend.atrPercent * regimeConfig.stopMultiplier);
  const targetPercent = Math.max(0.12, trend.atrPercent * regimeConfig.targetMultiplier);

  reasons.push(`RSI=${trend.rsi.toFixed(0)}`);
  reasons.push(`ATR=${trend.atrPercent.toFixed(3)}%(${trend.atrSource})`);

  return {
    detected: true,
    side,
    mode: "swing_trend",
    reason: `📈 TREND ${side.toUpperCase()}: ${reasons.join(", ")}, target=${targetPercent.toFixed(3)}%, stop=${stopPercent.toFixed(3)}% @ $${price.toFixed(1)}`,
    strength,
    suggestedMinHoldSeconds: regimeConfig.minHoldSeconds,
    stopPercent,
    targetPercent,
    hardMaxHoldSeconds: regimeConfig.maxHoldSeconds,
    trailingStop: regimeConfig.trailingStopEnabled ? {
      activationPercent: targetPercent * 0.4,
      trailPercent: targetPercent * 0.3,
    } : undefined,
    maxLossDollars: 30,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// PULLBACK ENTRY — Gold's bread and butter in trends
// Per [mudrex.com](https://mudrex.com/learn/gold-futures-swing-trading-ma-rsi-strategy/):
// "Use 21/50 MAs plus RSI(14) 40-60 zones for pullback entries"
// ═══════════════════════════════════════════════════════════════════════

function detectPullbackSignal(
  candles1m: Candle[],
  candles5m: Candle[],
  trend: TrendAssessment,
  regimeConfig: RegimeConfig,
  sessionConfig: SessionConfig,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
  safeHaven?: SafeHavenSignal,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });
  const price = candles1m[candles1m.length - 1].close;

  if (candles5m.length < 12) return noSignal("Insufficient 5m candles for pullback");

  const closes5m = candles5m.map(c => c.close);
  const ema21_5m = calcEMA(closes5m, 21);
  const ema50_5m = calcEMA(closes5m, Math.min(50, closes5m.length));

  const trendUp = ema21_5m > ema50_5m;
  const trendDown = ema21_5m < ema50_5m;

  if (!trendUp && !trendDown) {
    return noSignal(`No EMA trend for pullback @ $${price.toFixed(1)}`);
  }

  const side: "Long" | "Short" = trendUp ? "Long" : "Short";

  // Counter-trend blocking
  const counterTrend = briefDirective && (
    (briefDirective.bias === "long" && side === "Short") ||
    (briefDirective.bias === "short" && side === "Long")
  );
  if (counterTrend && (briefDirective!.regimeConfidence || 0) >= 0.6) {
    return noSignal(`${side} pullback blocked: counter-trend @ $${price.toFixed(1)}`);
  }

  // Gold-specific: price must be near EMA21 (tighter thresholds than BTC)
  const distFromEma21Pct = ((price - ema21_5m) / ema21_5m) * 100;

  if (side === "Long") {
    if (distFromEma21Pct > 0.10) return noSignal(`Long pullback: too far above EMA21 (${distFromEma21Pct.toFixed(3)}%) @ $${price.toFixed(1)}`);
    if (distFromEma21Pct < -0.30) return noSignal(`Long pullback: too far below EMA21 (${distFromEma21Pct.toFixed(3)}%) — trend break? @ $${price.toFixed(1)}`);
  } else {
    if (distFromEma21Pct < -0.10) return noSignal(`Short pullback: too far below EMA21 (${distFromEma21Pct.toFixed(3)}%) @ $${price.toFixed(1)}`);
    if (distFromEma21Pct > 0.30) return noSignal(`Short pullback: too far above EMA21 (${distFromEma21Pct.toFixed(3)}%) — trend break? @ $${price.toFixed(1)}`);
  }

  // Bounce candle confirmation on 1m
  const last1m = candles1m[candles1m.length - 1];
  const prev1m = candles1m.length > 1 ? candles1m[candles1m.length - 2] : null;

  const lastMove = last1m.close - last1m.open;
  const bouncingRight = (side === "Long" && lastMove > 0) || (side === "Short" && lastMove < 0);

  if (!bouncingRight) {
    return noSignal(`${side} pullback: no bounce candle @ $${price.toFixed(1)}`);
  }

  const prevMove = prev1m ? (prev1m.close - prev1m.open) : 0;
  const wasPullingBack = (side === "Long" && prevMove < 0) || (side === "Short" && prevMove > 0);

  // RSI in pullback zone (40-60 per mudrex gold strategy)
  if (side === "Long" && trend.rsi > 68) return noSignal(`Long pullback: RSI too high (${trend.rsi.toFixed(0)}) @ $${price.toFixed(1)}`);
  if (side === "Short" && trend.rsi < 32) return noSignal(`Short pullback: RSI too low (${trend.rsi.toFixed(0)}) @ $${price.toFixed(1)}`);

  // ─── STRENGTH ───
  let strength = 0.28;
  const reasons: string[] = [`dist_EMA21=${distFromEma21Pct.toFixed(3)}%`];

  // Trend gap strength
  const trendGap = Math.abs(((ema21_5m - ema50_5m) / ema50_5m) * 100);
  strength += Math.min(trendGap * 0.8, 0.12);
  if (trendGap > 0.03) reasons.push(`trendGap=${trendGap.toFixed(3)}%`);

  if (wasPullingBack) { strength += 0.10; reasons.push("pullback_confirmed"); }

  // RSI in sweet zone
  if (trend.rsi >= 40 && trend.rsi <= 60) {
    strength += 0.08;
    reasons.push(`RSI_sweet(${trend.rsi.toFixed(0)})`);
  }

  // Bounce quality
  const bounceRange = last1m.high - last1m.low;
  const bounceBody = Math.abs(lastMove);
  const bounceQuality = bounceRange > 0 ? bounceBody / bounceRange : 0;
  strength += bounceQuality * 0.08;

  // VWAP alignment
  if ((side === "Long" && price > trend.vwap) || (side === "Short" && price < trend.vwap)) {
    strength += 0.06;
    reasons.push("VWAP_aligned");
  }

  // Safe haven
  if (safeHaven?.active && side === "Long") {
    strength += safeHaven.strength * 0.12;
    reasons.push("safe_haven");
  }

  // Researcher alignment
  if (briefDirective?.bias === (side === "Long" ? "long" : "short")) {
    strength += 0.10;
    reasons.push("bias_aligned");
  }

  // OB alignment
  if (orderbook && orderbook.strength > 0.2) {
    if ((orderbook.lean === "long" && side === "Long") || (orderbook.lean === "short" && side === "Short")) {
      strength += 0.06;
      reasons.push(`OB:${orderbook.ratio.toFixed(2)}`);
    }
  }

  // Session scaling
  strength *= sessionConfig.aggressionMultiplier;
  strength = Math.max(0, Math.min(1.0, strength));

  const minStr = Math.max((sessionConfig.minStrengthOverride || regimeConfig.minStrength) - 0.05, 0.25);
  if (strength < minStr) {
    return noSignal(`${side} pullback too weak (${strength.toFixed(2)} < ${minStr.toFixed(2)}) @ $${price.toFixed(1)}`);
  }

  const stopPercent = Math.max(0.06, trend.atrPercent * regimeConfig.stopMultiplier * 0.8);
  const targetPercent = Math.max(0.10, trend.atrPercent * regimeConfig.targetMultiplier * 0.7);

  reasons.push(`RSI=${trend.rsi.toFixed(0)}`);

  return {
    detected: true,
    side,
    mode: "swing_pullback",
    reason: `🔄 PULLBACK ${side.toUpperCase()}: ${reasons.join(", ")}, target=${targetPercent.toFixed(3)}%, stop=${stopPercent.toFixed(3)}% @ $${price.toFixed(1)}`,
    strength,
    suggestedMinHoldSeconds: regimeConfig.minHoldSeconds,
    stopPercent,
    targetPercent,
    hardMaxHoldSeconds: regimeConfig.maxHoldSeconds,
    trailingStop: regimeConfig.trailingStopEnabled ? {
      activationPercent: targetPercent * 0.5,
      trailPercent: targetPercent * 0.35,
    } : undefined,
    maxLossDollars: 25,
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
  sessionConfig: SessionConfig,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
  safeHaven?: SafeHavenSignal,
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

  if (!trendSide || obSide === trendSide) {
    return noSignal(`OB (${obSide}) agrees with trend (${trendSide}) — no divergence @ $${price.toFixed(1)}`);
  }

  const side = obSide;

  const strongOB = orderbook.ratio > 1.8 || orderbook.ratio < 0.55;
  if (!strongOB) {
    return noSignal(`${side} divergence: OB not strong enough (ratio:${orderbook.ratio.toFixed(2)}) @ $${price.toFixed(1)}`);
  }

  const rsiExtreme = (side === "Long" && trend.rsi < 38) || (side === "Short" && trend.rsi > 62);
  if (!rsiExtreme) {
    return noSignal(`${side} divergence: RSI not extreme (${trend.rsi.toFixed(0)}) @ $${price.toFixed(1)}`);
  }

  const bbExtreme = (side === "Long" && trend.bbands.percentB < 0.15) ||
                    (side === "Short" && trend.bbands.percentB > 0.85);

  const lastCandle = candles1m[candles1m.length - 1];
  const body = Math.abs(lastCandle.close - lastCandle.open);
  const range = lastCandle.high - lastCandle.low;
  const hasRejection = range > 0 && body / range < 0.5;

  let strength = 0.28;
  const reasons: string[] = [`OB:${orderbook.ratio.toFixed(2)}/${orderbook.lean}`];

  strength += Math.min(orderbook.strength * 0.18, 0.18);
  if (rsiExtreme) { strength += 0.10; reasons.push(`RSI=${trend.rsi.toFixed(0)}`); }
  if (bbExtreme) { strength += 0.08; reasons.push(`BB%=${trend.bbands.percentB.toFixed(2)}`); }
  if (hasRejection) { strength += 0.10; reasons.push("rejection_wick"); }

  // Safe haven for long divergence
  if (safeHaven?.active && side === "Long") {
    strength += safeHaven.strength * 0.12;
    reasons.push("safe_haven");
  }

  // Session scaling
  strength *= sessionConfig.aggressionMultiplier;
  strength = Math.max(0, Math.min(1.0, strength));

  const minStr = Math.max((sessionConfig.minStrengthOverride || regimeConfig.minStrength) + 0.08, 0.45);
  if (strength < minStr) {
    return noSignal(`${side} divergence too weak (${strength.toFixed(2)} < ${minStr.toFixed(2)}) @ $${price.toFixed(1)}`);
  }

  const stopPercent = Math.max(0.08, trend.atrPercent * 0.6);
  const targetPercent = Math.max(0.12, trend.atrPercent * 1.2);

  return {
    detected: true,
    side,
    mode: "swing_divergence",
    reason: `📊 DIVERGENCE ${side.toUpperCase()}: ${reasons.join(", ")}, target=${targetPercent.toFixed(3)}%, stop=${stopPercent.toFixed(3)}% @ $${price.toFixed(1)}`,
    strength,
    suggestedMinHoldSeconds: regimeConfig.minHoldSeconds,
    stopPercent,
    targetPercent,
    hardMaxHoldSeconds: regimeConfig.maxHoldSeconds,
    trailingStop: {
      activationPercent: targetPercent * 0.5,
      trailPercent: targetPercent * 0.3,
    },
    maxLossDollars: 25,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SESSION BREAKOUT — London open and NY open are key for gold
// Gold makes structural moves at session opens
// ═══════════════════════════════════════════════════════════════════════

function detectSessionBreakoutSignal(
  candles1m: Candle[],
  candles5m: Candle[],
  trend: TrendAssessment,
  regimeConfig: RegimeConfig,
  sessionInfo: { session: GoldSession; config: SessionConfig },
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
  safeHaven?: SafeHavenSignal,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });
  const price = candles1m[candles1m.length - 1].close;

  // Only at session opens: London (03:00-04:00 UTC) and NY (13:00-14:30 UTC)
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const timeDecimal = utcHour + utcMinute / 60;

  const isLondonOpen = timeDecimal >= 3 && timeDecimal < 4;
  const isNYOpen = timeDecimal >= 13 && timeDecimal < 14.5;

  if (!isLondonOpen && !isNYOpen) {
    return noSignal("Not at session open");
  }

  if (candles5m.length < 6) return noSignal("Insufficient candles for session breakout");

  // Look at Asian range (for London open) or morning range (for NY open)
  const rangeCandles = candles5m.slice(-Math.min(12, candles5m.length));
  const rangeHigh = Math.max(...rangeCandles.map(c => c.high));
  const rangeLow = Math.min(...rangeCandles.map(c => c.low));
  const rangeSize = rangeHigh - rangeLow;
  const rangePct = price > 0 ? (rangeSize / price) * 100 : 0;

  // Need the range to be tight enough to breakout from
  if (rangePct > 0.40) {
    return noSignal(`Session breakout: prior range too wide (${rangePct.toFixed(3)}%) @ $${price.toFixed(1)}`);
  }

  // Detect breakout direction
  let side: "Long" | "Short" | null = null;
  const breakoutMargin = rangeSize * 0.15; // 15% above/below range

  if (price > rangeHigh + breakoutMargin) {
    side = "Long";
  } else if (price < rangeLow - breakoutMargin) {
    side = "Short";
  }

  if (!side) {
    return noSignal(`Session breakout: price within range ($${rangeLow.toFixed(1)}-$${rangeHigh.toFixed(1)}) @ $${price.toFixed(1)}`);
  }

  // Volume confirmation: breakout should have volume
  const recentVols = candles1m.slice(-5).map(c => c.volume);
  const avgVol = candles1m.slice(-15, -5).map(c => c.volume);
  const avgVolVal = avgVol.length > 0 ? avgVol.reduce((a, b) => a + b, 0) / avgVol.length : 0;
  const currentVol = recentVols[recentVols.length - 1] || 0;
  const volRatio = avgVolVal > 0 ? currentVol / avgVolVal : 1;

  let strength = 0.35;
  const reasons: string[] = [isLondonOpen ? "London_open" : "NY_open"];
  reasons.push(`range=${rangePct.toFixed(3)}%`);

  // Volume confirmation
  if (volRatio > 1.5) { strength += 0.12; reasons.push(`vol=${volRatio.toFixed(1)}x`); }

  // MACD alignment
  const macdAligned = (side === "Long" && trend.macd.histogram > 0) ||
                      (side === "Short" && trend.macd.histogram < 0);
  if (macdAligned) { strength += 0.10; reasons.push("MACD_aligned"); }

  // Researcher alignment
  if (briefDirective?.bias === (side === "Long" ? "long" : "short")) {
    strength += 0.10;
    reasons.push("bias_aligned");
  }

  // Safe haven
  if (safeHaven?.active && side === "Long") {
    strength += safeHaven.strength * 0.12;
    reasons.push("safe_haven");
  }

  // OB
  if (orderbook && orderbook.strength > 0.2) {
    if ((orderbook.lean === "long" && side === "Long") || (orderbook.lean === "short" && side === "Short")) {
      strength += 0.08;
      reasons.push(`OB:${orderbook.ratio.toFixed(2)}`);
    }
  }

  strength = Math.max(0, Math.min(1.0, strength));

  if (strength < 0.40) {
    return noSignal(`Session breakout ${side}: too weak (${strength.toFixed(2)}) @ $${price.toFixed(1)}`);
  }

  // Wider targets for session breakouts — these can run
  const stopPercent = Math.max(0.08, rangePct * 0.5);
  const targetPercent = Math.max(0.15, rangePct * 1.0);

  return {
    detected: true,
    side,
    mode: "session_breakout",
    reason: `🌅 SESSION_BREAKOUT ${side.toUpperCase()}: ${reasons.join(", ")}, target=${targetPercent.toFixed(3)}%, stop=${stopPercent.toFixed(3)}% @ $${price.toFixed(1)}`,
    strength,
    suggestedMinHoldSeconds: 300,
    stopPercent,
    targetPercent,
    hardMaxHoldSeconds: 5400,
    trailingStop: {
      activationPercent: targetPercent * 0.4,
      trailPercent: targetPercent * 0.3,
    },
    maxLossDollars: 30,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN EXPORTED FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * detectMomentum — Primary entry signal detector for gold futures.
 * v2.0: Gold-specific with session awareness, safe-haven detection,
 *       EMA bounce signals, and properly calibrated ATR thresholds.
 *
 * Signal priority varies by regime and session:
 *   HIGH_VOL_CHOP: MR → EMA Bounce → Pullback → Divergence
 *   TRENDING: Trend → Session Breakout → EMA Bounce → Pullback → MR
 *   LOW_VOL: EMA Bounce → Pullback (conservative)
 *   MAINTENANCE: No trading
 */
export function detectMomentum(
  candles: Candle[],
  momentumThreshold: number = 0.05,
  maxChase: number = 0.4,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
): MomentumSignal {
  const noSignal: MomentumSignal = { detected: false, reason: "No signal" };

  if (candles.length < 15) {
    return { ...noSignal, reason: `Insufficient candles: ${candles.length} (need 15)` };
  }

  // Session check — gold is session-driven
  const sessionInfo = getCurrentSession();
  const sessionCfg = sessionInfo.config;

  // Block trading during maintenance
  if (sessionInfo.session === "maintenance") {
    return { ...noSignal, reason: `⏸️ MAINTENANCE BREAK (22:00-23:00 UTC) — no trading` };
  }

  // Determine regime and configuration
  const regime = briefDirective?.regime ||