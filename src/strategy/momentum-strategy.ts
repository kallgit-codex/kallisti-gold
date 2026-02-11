// KALLISTI GOLD v3.0 - Gold Futures Adaptive Strategy
// v3.0: COMPLETE REWRITE — fixes all trade-blocking issues
//
// CRITICAL FIXES FROM v2.0:
//   1. Brief staleness check REMOVED from strategy — handled upstream with 30min tolerance
//   2. Internal regime classification NO LONGER overrides researcher's regime
//   3. ATR minimums set to 0.005% — gold 1m ATR of 0.03-0.06% is NORMAL and tradeable
//   4. Strength thresholds dramatically lowered — gold signals are inherently weaker than BTC
//   5. Simplified signal pipeline — fewer gates = more trades
//   6. Per [mql5.com](https://www.mql5.com/en/blogs/post/766745): gold respects EMAs, RSI+MACD combo works
//   7. Per [mrktedge.ai](https://www.mrktedge.ai/blog/gold-xau-usd-gc-fundamental-technical-analysis-22-december-2025): buy above key levels, don't wait for deep pullbacks
//   8. Per [quantstock.org](https://quantstock.org/strategy-guide/macd): MACD crossover + histogram for momentum
//   9. Per [mql5.com](https://www.mql5.com/en/articles/20488): filtered MA crossovers reduce noise
//  10. Per [mql5.com](https://mql5.com/en/articles/16856): dynamic trend/mean-reversion regime switching
//
// GOLD CHARACTERISTICS:
//   - Daily range: 0.5-1.2% (vs BTC 2-5%)
//   - 1m ATR: typically 0.03-0.10% — THIS IS NORMAL, NOT LOW
//   - Hourly ATR: typically 0.15-0.60%
//   - Trends: cleaner, session-driven (London open, NY overlap)
//   - Mean reverts to 9/21 EMA intraday
//   - Safe haven: rallies when equities/crypto crash
//   - Maintenance break: 22:00-23:00 UTC daily
//
// STRATEGY MODES (selected by researcher regime, NOT overridden internally):
//   A. TRENDING → Trend Following + EMA Pullbacks (ride the move)
//   B. MEAN REVERSION → Fade BB/StochRSI extremes, EMA bounces
//   C. BREAKOUT → Session open breakouts
//
// SESSIONS (affects aggression):
//   - Asian (23:00-03:00 UTC): conservative
//   - London (03:00-08:00 UTC): moderate
//   - London/NY Overlap (13:00-17:00 UTC): aggressive
//   - NY (08:00-20:00 UTC): moderate-aggressive
//   - Pre-maintenance (20:00-22:00 UTC): wind down
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
  aggressionMultiplier: number;
  preferredModes: string[];
  maxTradesPerHour: number;
}

const SESSION_CONFIGS: Record<GoldSession, SessionConfig> = {
  asian: {
    name: "Asian (Low Vol)",
    aggressionMultiplier: 0.85,
    preferredModes: ["ema_bounce", "mean_reversion"],
    maxTradesPerHour: 3,
  },
  london: {
    name: "London Open",
    aggressionMultiplier: 1.0,
    preferredModes: ["swing_trend", "session_breakout", "ema_bounce", "swing_pullback"],
    maxTradesPerHour: 4,
  },
  london_ny_overlap: {
    name: "London/NY Overlap (Peak)",
    aggressionMultiplier: 1.15,
    preferredModes: ["swing_trend", "session_breakout", "ema_bounce", "swing_pullback", "mean_reversion"],
    maxTradesPerHour: 5,
  },
  new_york: {
    name: "New York",
    aggressionMultiplier: 1.0,
    preferredModes: ["swing_trend", "ema_bounce", "swing_pullback", "mean_reversion"],
    maxTradesPerHour: 4,
  },
  pre_maintenance: {
    name: "Pre-Maintenance Wind Down",
    aggressionMultiplier: 0.6,
    preferredModes: ["mean_reversion", "ema_bounce"],
    maxTradesPerHour: 2,
  },
  maintenance: {
    name: "Maintenance Break",
    aggressionMultiplier: 0,
    preferredModes: [],
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
  } else if (timeDecimal >= 20 && timeDecimal < 22) {
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
// REGIME MAPPING — Trust the researcher, map to trade parameters
// KEY FIX: We do NOT re-classify regime internally. The researcher's
// regime is authoritative. We only map it to trade parameters.
// ═══════════════════════════════════════════════════════════════════════

interface TradeParams {
  stopMultiplier: number;
  targetMultiplier: number;
  minHoldSeconds: number;
  maxHoldSeconds: number;
  trailingStopEnabled: boolean;
  minStrength: number;
}

function getTradeParams(regime: string, confidence: number): TradeParams {
  const normalized = regime.toLowerCase().replace(/[\s-]+/g, "_");

  // Trending regimes — let trades run
  if (normalized.includes("trend") || normalized.includes("bull") || normalized.includes("bear")) {
    return {
      stopMultiplier: 1.0,
      targetMultiplier: 2.0,
      minHoldSeconds: 180,
      maxHoldSeconds: 5400,
      trailingStopEnabled: true,
      minStrength: 0.20,  // LOW bar — we want to trade when trending
    };
  }

  // Range/chop/sideways — mean reversion with tighter targets
  if (normalized.includes("chop") || normalized.includes("range") || normalized.includes("sideways") || normalized.includes("consolidat")) {
    return {
      stopMultiplier: 1.2,
      targetMultiplier: 0.8,
      minHoldSeconds: 120,
      maxHoldSeconds: 2400,
      trailingStopEnabled: false,
      minStrength: 0.25,
    };
  }

  // Low vol / quiet
  if (normalized.includes("low_vol") || normalized.includes("quiet") || normalized.includes("calm")) {
    return {
      stopMultiplier: 1.5,
      targetMultiplier: 1.0,
      minHoldSeconds: 120,
      maxHoldSeconds: 1800,
      trailingStopEnabled: false,
      minStrength: 0.28,
    };
  }

  // High volatility
  if (normalized.includes("high_vol") || normalized.includes("volatile")) {
    return {
      stopMultiplier: 1.3,
      targetMultiplier: 1.5,
      minHoldSeconds: 120,
      maxHoldSeconds: 3600,
      trailingStopEnabled: true,
      minStrength: 0.22,
    };
  }

  // Default / unknown — be permissive, let the signal quality decide
  return {
    stopMultiplier: 1.0,
    targetMultiplier: 1.5,
    minHoldSeconds: 150,
    maxHoldSeconds: 3600,
    trailingStopEnabled: true,
    minStrength: 0.22,
  };
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

    // Extract volatility data
    const volatility: BriefDirective["volatility"] = {} as any;
    let hasVolatility = false;

    const volSources = [brief.volatility, brief.vol, brief.technical, brief.trend_data, brief.trendData, ms];

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
// Per [mql5.com](https://www.mql5.com/en/blogs/post/766745): EMA 21/50,
// RSI above/below 50 for momentum, MACD for trend strength
// Per [quantstock.org](https://quantstock.org/strategy-guide/macd): MACD
// histogram shifts for momentum confirmation
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
// CRITICAL: Gold 1m ATR of 0.03-0.06% is NORMAL and tradeable.
// The old code blocked this as "too low" — that's wrong for gold.
// ═══════════════════════════════════════════════════════════════════════

function getEffectiveATRPercent(
  candles: Candle[],
  briefDirective?: BriefDirective,
): { hourly: number; local1m: number; source: string } {
  let hourly = 0;
  let source = "default";

  // PRIORITY 1: Researcher's ATR
  if (briefDirective?.volatility?.atrPercent && briefDirective.volatility.atrPercent > 0) {
    hourly = briefDirective.volatility.atrPercent;
    source = "researcher_atr";
  }

  // PRIORITY 2: ATR from trend data
  if (!hourly && briefDirective?.trendData?.atrPercent && briefDirective.trendData.atrPercent > 0) {
    hourly = briefDirective.trendData.atrPercent;
    source = "trend_data_atr";
  }

  // PRIORITY 3: Estimate from 24h range
  if (!hourly && briefDirective?.volatility?.range24hPercent && briefDirective.volatility.range24hPercent > 0) {
    hourly = briefDirective.volatility.range24hPercent / 4.5;
    source = "range_24h_derived";
  }

  // Calculate local 1m ATR
  let local1m = 0;
  if (candles.length >= 5) {
    const localATR = calcATR(candles, Math.min(14, candles.length - 1));
    const price = candles[candles.length - 1].close;
    if (price > 0 && localATR > 0) {
      local1m = (localATR / price) * 100;
    }
  }

  // PRIORITY 4: Scale local 1m ATR to hourly estimate
  // Gold: 1m ATR ~0.03-0.10%, hourly ~0.15-0.60%
  if (!hourly && local1m > 0) {
    hourly = local1m * 5.0;
    source = "local_1m_scaled";
  }

  // PRIORITY 5: Sensible gold default
  if (!hourly) {
    hourly = 0.30;
    source = "gold_default";
  }

  return { hourly, local1m, source };
}

// ═══════════════════════════════════════════════════════════════════════
// SAFE HAVEN DETECTION
// ═══════════════════════════════════════════════════════════════════════

interface SafeHavenSignal {
  active: boolean;
  bias: "long" | "neutral";
  strength: number;
  reason: string;
}

function detectSafeHavenBias(briefDirective?: BriefDirective): SafeHavenSignal {
  const neutral: SafeHavenSignal = { active: false, bias: "neutral", strength: 0, reason: "no signal" };
  if (!briefDirective) return neutral;

  let strength = 0;
  const reasons: string[] = [];

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

  if (briefDirective.bias === "long" && briefDirective.regimeConfidence > 0.7) {
    strength += 0.15;
    reasons.push("researcher_long_bias");
  }

  if (strength >= 0.15) {
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
// Per [mql5.com](https://www.mql5.com/en/blogs/post/766745):
//   EMA 21/50 for trend, RSI above/below 50 for momentum,
//   MACD crossing zero for trend acceleration
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
  atrPercent: number;
  localAtrPercent: number;
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

  // Trend scoring — weighted components
  // Per [mql5.com](https://www.mql5.com/en/blogs/post/766745):
  // Price above EMAs = bullish, RSI > 50 = bullish momentum
  let score = 0;

  // EMA stack (most important for gold)
  if (ema9 > ema21) score += 1.0; else score -= 1.0;
  if (ema21 > ema50) score += 0.8; else score -= 0.8;

  // Price position relative to EMAs
  if (currentPrice > ema9) score += 0.5; else score -= 0.5;
  if (currentPrice > ema21) score += 0.4; else score -= 0.4;

  // VWAP
  if (currentPrice > vwap) score += 0.3; else score -= 0.3;

  // MACD — per [quantstock.org](https://quantstock.org/strategy-guide/macd):
  // histogram > 0 = bullish momentum, growing histogram = strengthening
  if (macd.histogram > 0) score += 0.5; else score -= 0.5;
  if (isHistogramGrowing && macd.histogram > 0) score += 0.3;
  if (isHistogramGrowing && macd.histogram < 0) score -= 0.3;

  // RSI — per [mql5.com](https://www.mql5.com/en/blogs/post/766745):
  // RSI above 50 = bullish momentum (using 45-55 neutral zone for gold)
  if (rsi > 55) score += 0.4; else if (rsi < 45) score -= 0.4;

  let direction: "bullish" | "bearish" | "neutral" = "neutral";
  // Lower threshold to detect trends — gold trends are subtler
  if (score >= 1.2) direction = "bullish";
  else if (score <= -1.2) direction = "bearish";

  const strength = Math.min(Math.abs(score) / 4.5, 1.0);

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
// SIGNAL: EMA BOUNCE — Gold's bread and butter
// Gold mean-reverts beautifully to 9 and 21 EMAs intraday.
// Per [mrktedge.ai](https://www.mrktedge.ai/blog/gold-xau-usd-gc-fundamental-technical-analysis-22-december-2025):
// "buying above key levels rather than waiting for deep pullbacks"
// ═══════════════════════════════════════════════════════════════════════

function detectEMABounce(
  candles1m: Candle[],
  trend: TrendAssessment,
  tradeParams: TradeParams,
  sessionConfig: SessionConfig,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
  safeHaven?: SafeHavenSignal,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });
  const price = candles1m[candles1m.length - 1].close;

  if (candles1m.length < 12) return noSignal("Insufficient candles for EMA bounce");

  const distEma9 = trend.priceVsEma9Pct;
  const distEma21 = trend.priceVsEma21Pct;

  // Need some EMA ordering for direction
  const emaStackUp = trend.ema9 > trend.ema21;
  const emaStackDown = trend.ema9 < trend.ema21;

  if (!emaStackUp && !emaStackDown) {
    return noSignal(`EMA bounce: EMAs crossed (9=${trend.ema9.toFixed(1)} 21=${trend.ema21.toFixed(1)})`);
  }

  const side: "Long" | "Short" = emaStackUp ? "Long" : "Short";

  // Gold-specific EMA proximity thresholds
  // Gold 1m: EMA9 touch ≈ 0.01-0.05%, EMA21 touch ≈ 0.03-0.10%
  const nearEma9 = Math.abs(distEma9) < 0.05;
  const nearEma21 = Math.abs(distEma21) < 0.10;

  // For longs: price should be at or slightly below EMA (pullback to EMA)
  // For shorts: price should be at or slightly above EMA
  const pulledBackToEma9 = side === "Long"
    ? (distEma9 > -0.06 && distEma9 < 0.02)
    : (distEma9 < 0.06 && distEma9 > -0.02);
  const pulledBackToEma21 = side === "Long"
    ? (distEma21 > -0.10 && distEma21 < 0.03)
    : (distEma21 < 0.10 && distEma21 > -0.03);

  if (!nearEma9 && !nearEma21 && !pulledBackToEma9 && !pulledBackToEma21) {
    return noSignal(`EMA bounce: price too far (d9=${distEma9.toFixed(3)}% d21=${distEma21.toFixed(3)}%)`);
  }

  // Bounce confirmation: last candle should move in trade direction
  const last = candles1m[candles1m.length - 1];
  const prev = candles1m[candles1m.length - 2];
  const lastMove = last.close - last.open;
  const prevMove = prev.close - prev.open;

  const bouncing = (side === "Long" && lastMove > 0) || (side === "Short" && lastMove < 0);
  const wasPullingBack = (side === "Long" && prevMove < 0) || (side === "Short" && prevMove > 0);

  // Don't require perfect bounce — gold can bounce slowly
  // Just need some directional move or at least neutral (small doji)
  const priceRange = last.high - last.low;
  const bodySize = Math.abs(lastMove);
  const isSmallCandle = priceRange > 0 && bodySize / priceRange < 0.3;

  if (!bouncing && !isSmallCandle) {
    return noSignal(`EMA bounce ${side}: no bounce candle (move=${lastMove.toFixed(2)})`);
  }

  // RSI sanity — don't enter at extremes
  if (side === "Long" && trend.rsi > 72) return noSignal(`EMA bounce Long: RSI high (${trend.rsi.toFixed(0)})`);
  if (side === "Short" && trend.rsi < 28) return noSignal(`EMA bounce Short: RSI low (${trend.rsi.toFixed(0)})`);

  // ─── STRENGTH SCORING ───
  let strength = 0.20;
  const reasons: string[] = [];

  // EMA proximity bonuses
  if (nearEma9 || pulledBackToEma9) {
    strength += 0.10;
    reasons.push(`EMA9(${distEma9.toFixed(3)}%)`);
  }
  if (nearEma21 || pulledBackToEma21) {
    strength += 0.12;
    reasons.push(`EMA21(${distEma21.toFixed(3)}%)`);
  }

  // Full EMA stack (9 > 21 > 50 or reverse)
  const fullStack = emaStackUp ? (trend.ema21 > trend.ema50) : (trend.ema21 < trend.ema50);
  if (fullStack) {
    strength += 0.08;
    reasons.push("full_stack");
  }

  // Pullback-then-bounce pattern
  if (wasPullingBack && bouncing) {
    strength += 0.10;
    reasons.push("pullback_bounce");
  } else if (bouncing) {
    strength += 0.05;
    reasons.push("bounce");
  }

  // RSI in sweet zone (40-60) per [mql5.com](https://www.mql5.com/en/blogs/post/766745)
  if (trend.rsi >= 40 && trend.rsi <= 60) {
    strength += 0.06;
    reasons.push(`RSI=${trend.rsi.toFixed(0)}`);
  }

  // VWAP alignment
  if ((side === "Long" && price > trend.vwap) || (side === "Short" && price < trend.vwap)) {
    strength += 0.05;
    reasons.push("VWAP_ok");
  }

  // MACD alignment
  if ((side === "Long" && trend.macd.histogram > 0) || (side === "Short" && trend.macd.histogram < 0)) {
    strength += 0.06;
    reasons.push("MACD_ok");
  }

  // Safe haven boost
  if (safeHaven?.active && side === "Long") {
    strength += safeHaven.strength * 0.10;
    reasons.push("safe_haven");
  }

  // Researcher bias alignment — IMPORTANT, trust the researcher
  if (briefDirective?.bias === (side === "Long" ? "long" : "short")) {
    strength += 0.10 * (briefDirective.regimeConfidence || 0.5);
    reasons.push("bias_aligned");
  }

  // OB alignment
  if (orderbook && orderbook.strength > 0.15) {
    if ((orderbook.lean === "long" && side === "Long") || (orderbook.lean === "short" && side === "Short")) {
      strength += 0.06 * orderbook.strength;
      reasons.push(`OB:${orderbook.ratio.toFixed(2)}`);
    }
  }

  // Counter-trend penalty (but not a blocker — EMA bounces in micro-trends within larger counter-trend are fine)
  if (briefDirective?.bias && briefDirective.bias !== "neutral" &&
      briefDirective.bias !== (side === "Long" ? "long" : "short") &&
      briefDirective.regimeConfidence > 0.7) {
    strength *= 0.70;
    reasons.push("counter_bias");
  }

  // Session scaling
  strength *= sessionConfig.aggressionMultiplier;
  strength = Math.max(0, Math.min(1.0, strength));

  if (strength < tradeParams.minStrength) {
    return noSignal(`EMA bounce ${side}: weak (${strength.toFixed(2)} < ${tradeParams.minStrength.toFixed(2)}) [${reasons.join(", ")}]`);
  }

  // ATR-based stop and target
  const atr = trend.atrPercent;
  const stopPercent = Math.max(0.06, atr * 0.4);
  const targetPercent = Math.max(0.08, atr * 0.6);

  reasons.push(`ATR=${atr.toFixed(3)}%(${trend.atrSource})`);

  return {
    detected: true,
    side,
    mode: "ema_bounce",
    reason: `📏 EMA_BOUNCE ${side}: ${reasons.join(", ")} str=${strength.toFixed(2)} tgt=${targetPercent.toFixed(3)}% stp=${stopPercent.toFixed(3)}% @$${price.toFixed(1)}`,
    strength,
    suggestedMinHoldSeconds: Math.max(90, tradeParams.minHoldSeconds),
    stopPercent,
    targetPercent,
    hardMaxHoldSeconds: tradeParams.maxHoldSeconds,
    trailingStop: {
      activationPercent: targetPercent * 0.6,
      trailPercent: targetPercent * 0.4,
    },
    maxLossDollars: 25,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SIGNAL: TREND FOLLOWING — Ride gold's clean trends
// Per [mql5.com](https://www.mql5.com/en/blogs/post/766745):
// "Price above EMAs → Bullish bias, EMA pullbacks → continuation"
// Per [mql5.com](https://mql5.com/en/articles/16856):
// Dynamic detection of trend vs range regime
// ═══════════════════════════════════════════════════════════════════════

function detectTrendSignal(
  candles1m: Candle[],
  candles5m: Candle[],
  trend: TrendAssessment,
  tradeParams: TradeParams,
  sessionConfig: SessionConfig,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
  safeHaven?: SafeHavenSignal,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });
  const price = candles1m[candles1m.length - 1].close;

  if (candles5m.length < 8) return noSignal("Insufficient 5m candles for trend");

  // Use BOTH internal trend assessment AND researcher bias
  // If researcher says trending with high confidence, trust it even if local technicals are ambiguous
  let effectiveDirection = trend.direction;
  let effectiveStrength = trend.strength;

  if (briefDirective && briefDirective.regimeConfidence >= 0.6) {
    const regimeIsTrending = briefDirective.regime.includes("trend") ||
                             briefDirective.regime.includes("bull") ||
                             briefDirective.regime.includes("bear");
    if (regimeIsTrending && briefDirective.bias !== "neutral") {
      // Boost or override direction based on researcher
      if (briefDirective.bias === "long" && effectiveDirection !== "bearish") {
        effectiveDirection = "bullish";
        effectiveStrength = Math.max(effectiveStrength, briefDirective.regimeConfidence * 0.6);
      } else if (briefDirective.bias === "short" && effectiveDirection !== "bullish") {
        effectiveDirection = "bearish";
        effectiveStrength = Math.max(effectiveStrength, briefDirective.regimeConfidence * 0.6);
      }
    }
  }

  if (effectiveDirection === "neutral") {
    return noSignal(`Trend neutral (str:${effectiveStrength.toFixed(2)})`);
  }

  const side: "Long" | "Short" = effectiveDirection === "bullish" ? "Long" : "Short";

  // Hard counter-trend block only with very high confidence
  const counterTrend = briefDirective && briefDirective.bias !== "neutral" && (
    (briefDirective.bias === "long" && side === "Short") ||
    (briefDirective.bias === "short" && side === "Long")
  );
  if (counterTrend && (briefDirective!.regimeConfidence || 0) >= 0.80) {
    return noSignal(`🚫 ${side} blocked: strong counter-trend (conf:${(briefDirective!.regimeConfidence || 0).toFixed(2)})`);
  }

  // MACD alignment — prefer aligned but don't hard-block
  const macdAligned = (side === "Long" && trend.macd.histogram > 0) ||
                      (side === "Short" && trend.macd.histogram < 0);

  // RSI: don't chase deep extremes
  if (side === "Long" && trend.rsi > 75) {
    return noSignal(`Long trend but RSI overbought (${trend.rsi.toFixed(0)})`);
  }
  if (side === "Short" && trend.rsi < 25) {
    return noSignal(`Short trend but RSI oversold (${trend.rsi.toFixed(0)})`);
  }

  // Position in range
  const posRange = positionInRange(candles5m, 20);

  // ─── STRENGTH SCORING ───
  let strength = 0;
  const reasons: string[] = [];

  // Trend direction strength (0-0.25)
  strength += effectiveStrength * 0.25;
  reasons.push(`trend=${effectiveDirection}(${effectiveStrength.toFixed(2)})`);

  // MACD momentum (0-0.18)
  if (macdAligned) {
    strength += 0.10;
    if (trend.isHistogramGrowing) {
      strength += 0.08;
      reasons.push("MACD↑");
    } else {
      reasons.push("MACD_ok");
    }
  } else {
    // MACD opposing — penalty but not a block
    strength -= 0.05;
    reasons.push("MACD_oppose");
  }

  // MACD crossover bonus per [quantstock.org](https://quantstock.org/strategy-guide/macd)
  if ((side === "Long" && trend.isMacdCrossUp) || (side === "Short" && trend.isMacdCrossDown)) {
    strength += 0.12;
    reasons.push("MACD_cross!");
  }

  // Position quality — not at extreme
  const posQuality = side === "Long" ? (1.0 - posRange.position) : posRange.position;
  strength += Math.max(0, posQuality * 0.08);

  // VWAP alignment
  if ((side === "Long" && price > trend.vwap) || (side === "Short" && price < trend.vwap)) {
    strength += 0.06;
    reasons.push("VWAP_ok");
  }

  // Safe haven
  if (safeHaven?.active && side === "Long") {
    strength += safeHaven.strength * 0.12;
    reasons.push("safe_haven");
  }
  if (safeHaven?.active && side === "Short") {
    strength -= safeHaven.strength * 0.15;
    reasons.push("SH_penalty");
  }

  // Researcher alignment — HIGH weight, we trust the researcher
  if (briefDirective) {
    const aligned = (briefDirective.bias === "long" && side === "Long") ||
                    (briefDirective.bias === "short" && side === "Short");
    if (aligned) {
      strength += 0.15 * (briefDirective.regimeConfidence || 0.5);
      reasons.push(`bias_aligned(${(briefDirective.regimeConfidence || 0.5).toFixed(2)})`);
    }
    if (counterTrend) {
      strength -= 0.10;
      reasons.push("counter_trend");
    }
  }

  // OB alignment
  if (orderbook && orderbook.strength > 0.15) {
    if ((orderbook.lean === "long" && side === "Long") ||
        (orderbook.lean === "short" && side === "Short")) {
      strength += 0.06 * orderbook.strength;
      reasons.push(`OB:${orderbook.ratio.toFixed(2)}`);
    }
  }

  // Volume confirmation on 5m
  if (candles5m.length >= 5) {
    const recentVols = candles5m.slice(-5).map(c => c.volume);
    const avgVol = recentVols.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, recentVols.length - 1);
    const currentVol = recentVols[recentVols.length - 1] || 0;
    const volRatio = avgVol > 0 ? currentVol / avgVol : 1;
    if (volRatio > 1.5) { strength += 0.04; reasons.push(`vol=${volRatio.toFixed(1)}x`); }
  }

  // Session scaling
  strength *= sessionConfig.aggressionMultiplier;
  strength = Math.max(0, Math.min(1.0, strength));

  if (strength < tradeParams.minStrength) {
    return noSignal(`${side} trend weak (${strength.toFixed(2)} < ${tradeParams.minStrength.toFixed(2)}) [${reasons.join(", ")}]`);
  }

  // ATR-based stops — gold trends are clean, wider targets
  const stopPercent = Math.max(0.06, trend.atrPercent * tradeParams.stopMultiplier);
  const targetPercent = Math.max(0.10, trend.atrPercent * tradeParams.targetMultiplier);

  reasons.push(`RSI=${trend.rsi.toFixed(0)}`);
  reasons.push(`ATR=${trend.atrPercent.toFixed(3)}%(${trend.atrSource})`);

  return {
    detected: true,
    side,
    mode: "swing_trend",
    reason: `📈 TREND ${side}: ${reasons.join(", ")} str=${strength.toFixed(2)} tgt=${targetPercent.toFixed(3)}% stp=${stopPercent.toFixed(3)}% @$${price.toFixed(1)}`,
    strength,
    suggestedMinHoldSeconds: tradeParams.minHoldSeconds,
    stopPercent,
    targetPercent,
    hardMaxHoldSeconds: tradeParams.maxHoldSeconds,
    trailingStop: tradeParams.trailingStopEnabled ? {
      activationPercent: targetPercent * 0.4,
      trailPercent: targetPercent * 0.3,
    } : undefined,
    maxLossDollars: 30,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SIGNAL: MEAN REVERSION — Fade BB/StochRSI extremes
// ═══════════════════════════════════════════════════════════════════════

function detectMeanReversion(
  candles1m: Candle[],
  candles5m: Candle[],
  trend: TrendAssessment,
  tradeParams: TradeParams,
  sessionConfig: SessionConfig,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
  safeHaven?: SafeHavenSignal,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });
  const price = candles1m[candles1m.length - 1].close;

  if (candles5m.length < 6) return noSignal("Insufficient 5m candles for MR");

  const closes5m = candles5m.map(c => c.close);
  const bb5m = calcBollingerBands(closes5m, Math.min(20, closes5m.length), 2);
  const rsi5m = calcRSI(closes5m, Math.min(14, closes5m.length - 1));
  const stochRSI = trend.stochRSI;

  // Directional extension check on 5m
  const lookback = Math.min(6, candles5m.length - 1);
  const recentCandles5m = candles5m.slice(-(lookback + 1));
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

  // ─── DETECT LONG MR (oversold) ───
  const oversold = stochRSI < 20 || (stochRSI < 30 && rsi5m < 40);
  const belowLowerBand = bb5m.percentB < 0.12;
  const nearLowerBand = bb5m.percentB < 0.25;
  const extendedDown = downCandles >= 3 && totalMovePct < -0.04;

  // ─── DETECT SHORT MR (overbought) ───
  const overbought = stochRSI > 80 || (stochRSI > 70 && rsi5m > 60);
  const aboveUpperBand = bb5m.percentB > 0.88;
  const nearUpperBand = bb5m.percentB > 0.75;
  const extendedUp = upCandles >= 3 && totalMovePct > 0.04;

  let side: "Long" | "Short" | null = null;
  let strength = 0;
  let reasons: string[] = [];

  // ─── EVALUATE LONG MR ───
  if (oversold && (belowLowerBand || (nearLowerBand && extendedDown))) {
    side = "Long";
    strength = 0.22;
    reasons.push(`stochRSI=${stochRSI.toFixed(0)}`);
    reasons.push(`BB%=${bb5m.percentB.toFixed(2)}`);

    if (belowLowerBand) { strength += 0.12; reasons.push("below_BB"); }
    if (extendedDown) { strength += 0.10; reasons.push(`ext↓(${downCandles}/${lookback})`); }
    if (stochRSI < 10) { strength += 0.08; reasons.push("deep_oversold"); }
    if (price < trend.vwap) { strength += 0.05; reasons.push("below_VWAP"); }

    if (safeHaven?.active) {
      strength += safeHaven.strength * 0.10;
      reasons.push("safe_haven");
    }

    if (orderbook && orderbook.lean === "long" && orderbook.strength > 0.15) {
      strength += 0.08 * orderbook.strength;
      reasons.push(`OB_bid:${orderbook.ratio.toFixed(2)}`);
    }

    if (briefDirective?.bias === "long") {
      strength += 0.08;
      reasons.push("bias_ok");
    }
    if (briefDirective?.bias === "short" && (briefDirective.regimeConfidence || 0) > 0.75) {
      strength -= 0.10;
      reasons.push("bias_oppose");
    }
  }

  // ─── EVALUATE SHORT MR ───
  if (!side && overbought && (aboveUpperBand || (nearUpperBand && extendedUp))) {
    side = "Short";
    strength = 0.22;
    reasons.push(`stochRSI=${stochRSI.toFixed(0)}`);
    reasons.push(`BB%=${bb5m.percentB.toFixed(2)}`);

    if (aboveUpperBand) { strength += 0.12; reasons.push("above_BB"); }
    if (extendedUp) { strength += 0.10; reasons.push(`ext↑(${upCandles}/${lookback})`); }
    if (stochRSI > 90) { strength += 0.08; reasons.push("deep_overbought"); }
    if (price > trend.vwap) { strength += 0.05; reasons.push("above_VWAP"); }

    // Safe haven penalizes shorts
    if (safeHaven?.active) {
      strength -= safeHaven.strength * 0.12;
      reasons.push("SH_short_penalty");
    }

    if (orderbook && orderbook.lean === "short" && orderbook.strength > 0.15) {
      strength += 0.08 * orderbook.strength;
      reasons.push(`OB_ask:${orderbook.ratio.toFixed(2)}`);
    }

    if (briefDirective?.bias === "short") {
      strength += 0.08;
      reasons.push("bias_ok");
    }
    if (briefDirective?.bias === "long" && (briefDirective.regimeConfidence || 0) > 0.75) {
      strength -= 0.10;
      reasons.push("bias_oppose");
    }
  }

  if (!side) {
    return noSignal(`MR: no extreme (stochRSI=${stochRSI.toFixed(0)}, BB%=${bb5m.percentB.toFixed(2)}, RSI5m=${rsi5m.toFixed(0)})`);
  }

  // Don't fade moves that are too large — likely a real breakout
  const maxFadeMove = Math.max(0.15, trend.atrPercent * 1.8);
  if (Math.abs(totalMovePct) > maxFadeMove) {
    return noSignal(`MR: move too large to fade (${Math.abs(totalMovePct).toFixed(3)}% > ${maxFadeMove.toFixed(3)}%)`);
  }

  // Session scaling
  strength *= sessionConfig.aggressionMultiplier;
  strength = Math.max(0, Math.min(1.0, strength));

  if (strength < tradeParams.minStrength) {
    return noSignal(`MR ${side}: weak (${strength.toFixed(2)} < ${tradeParams.minStrength.toFixed(2)}) [${reasons.join(", ")}]`);
  }

  // ATR-based stops
  const stopPercent = Math.max(0.05, trend.atrPercent * tradeParams.stopMultiplier);
  const targetPercent = Math.max(0.04, trend.atrPercent * tradeParams.targetMultiplier);

  return {
    detected: true,
    side,
    mode: "mean_reversion",
    reason: `🔄 MR ${side}: ${reasons.join(", ")} ATR=${trend.atrPercent.toFixed(3)}%(${trend.atrSource}) str=${strength.toFixed(2)} tgt=${targetPercent.toFixed(3)}% stp=${stopPercent.toFixed(3)}% @$${price.toFixed(1)}`,
    strength,
    suggestedMinHoldSeconds: tradeParams.minHoldSeconds,
    stopPercent,
    targetPercent,
    hardMaxHoldSeconds: tradeParams.maxHoldSeconds,
    trailingStop: tradeParams.trailingStopEnabled ? {
      activationPercent: targetPercent * 0.6,
      trailPercent: targetPercent * 0.4,
    } : undefined,
    maxLossDollars: 25,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SIGNAL: PULLBACK ENTRY — Gold's favorite pattern
// Per [mql5.com](https://www.mql5.com/en/blogs/post/766745):
// "EMA pullbacks → High-probability continuation entries"
// ═══════════════════════════════════════════════════════════════════════

function detectPullback(
  candles1m: Candle[],
  candles5m: Candle[],
  trend: TrendAssessment,
  tradeParams: TradeParams,
  sessionConfig: SessionConfig,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
  safeHaven?: SafeHavenSignal,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });
  const price = candles1m[candles1m.length - 1].close;

  if (candles5m.length < 10) return noSignal("Insufficient 5m candles for pullback");

  const closes5m = candles5m.map(c => c.close);
  const ema21_5m = calcEMA(closes5m, 21);
  const ema50_5m = calcEMA(closes5m, Math.min(50, closes5m.length));

  const trendUp = ema21_5m > ema50_5m;
  const trendDown = ema21_5m < ema50_5m;

  if (!trendUp && !trendDown) {
    return noSignal(`No 5m EMA trend for pullback`);
  }

  const side: "Long" | "Short" = trendUp ? "Long" : "Short";

  // Counter-trend block (only with very high confidence)
  if (briefDirective && briefDirective.bias !== "neutral" &&
      ((briefDirective.bias === "long" && side === "Short") ||
       (briefDirective.bias === "short" && side === "Long")) &&
      (briefDirective.regimeConfidence || 0) >= 0.80) {
    return noSignal(`${side} pullback blocked: strong counter-trend`);
  }

  // Price must be near EMA21 on 5m
  const distFromEma21Pct = ((price - ema21_5m) / ema21_5m) * 100;

  if (side === "Long") {
    if (distFromEma21Pct > 0.12) return noSignal(`Long pullback: too far above EMA21 (${distFromEma21Pct.toFixed(3)}%)`);
    if (distFromEma21Pct < -0.35) return noSignal(`Long pullback: too far below EMA21 (${distFromEma21Pct.toFixed(3)}%)`);
  } else {
    if (distFromEma21Pct < -0.12) return noSignal(`Short pullback: too far below EMA21 (${distFromEma21Pct.toFixed(3)}%)`);
    if (distFromEma21Pct > 0.35) return noSignal(`Short pullback: too far above EMA21 (${distFromEma21Pct.toFixed(3)}%)`);
  }

  // Bounce confirmation on 1m
  const last1m = candles1m[candles1m.length - 1];
  const prev1m = candles1m.length > 1 ? candles1m[candles1m.length - 2] : null;
  const lastMove = last1m.close - last1m.open;

  const bouncingRight = (side === "Long" && lastMove > 0) || (side === "Short" && lastMove < 0);
  const prevMove = prev1m ? (prev1m.close - prev1m.open) : 0;
  const wasPullingBack = (side === "Long" && prevMove < 0) || (side === "Short" && prevMove > 0);

  // More lenient — gold can have tiny candles, accept dojis
  const bodySize = Math.abs(lastMove);
  const candleRange = last1m.high - last1m.low;
  const isDoji = candleRange > 0 && bodySize / candleRange < 0.3;

  if (!bouncingRight && !isDoji) {
    return noSignal(`${side} pullback: no bounce (move=${lastMove.toFixed(2)})`);
  }

  // RSI sanity
  if (side === "Long" && trend.rsi > 70) return noSignal(`Long pullback: RSI high (${trend.rsi.toFixed(0)})`);
  if (side === "Short" && trend.rsi < 30) return noSignal(`Short pullback: RSI low (${trend.rsi.toFixed(0)})`);

  // ─── STRENGTH ───
  let strength = 0.22;
  const reasons: string[] = [`dist_EMA21=${distFromEma21Pct.toFixed(3)}%`];

  // Trend gap (EMA21 vs EMA50) shows trend strength
  const trendGap = Math.abs(((ema21_5m - ema50_5m) / ema50_5m) * 100);
  strength += Math.min(trendGap * 1.0, 0.10);
  if (trendGap > 0.02) reasons.push(`gap=${trendGap.toFixed(3)}%`);

  if (wasPullingBack && bouncingRight) { strength += 0.12; reasons.push("pullback_bounce"); }
  else if (bouncingRight) { strength += 0.06; reasons.push("bounce"); }

  // RSI in pullback zone
  if (trend.rsi >= 38 && trend.rsi <= 62) {
    strength += 0.06;
    reasons.push(`RSI=${trend.rsi.toFixed(0)}`);
  }

  // VWAP
  if ((side === "Long" && price > trend.vwap) || (side === "Short" && price < trend.vwap)) {
    strength += 0.05;
    reasons.push("VWAP_ok");
  }

  // Safe haven
  if (safeHaven?.active && side === "Long") {
    strength += safeHaven.strength * 0.10;
    reasons.push("safe_haven");
  }

  // Researcher
  if (briefDirective?.bias === (side === "Long" ? "long" : "short")) {
    strength += 0.10 * (briefDirective.regimeConfidence || 0.5);
    reasons.push("bias_aligned");
  }

  // OB
  if (orderbook && orderbook.strength > 0.15) {
    if ((orderbook.lean === "long" && side === "Long") || (orderbook.lean === "short" && side === "Short")) {
      strength += 0.05;
      reasons.push(`OB:${orderbook.ratio.toFixed(2)}`);
    }
  }

  // Session scaling
  strength *= sessionConfig.aggressionMultiplier;
  strength = Math.max(0, Math.min(1.0, strength));

  // Slightly lower bar for pullbacks — they're high probability
  const minStr = Math.max(tradeParams.minStrength - 0.03, 0.15);
  if (strength < minStr) {
    return noSignal(`${side} pullback weak (${strength.toFixed(2)} < ${minStr.toFixed(2)}) [${reasons.join(", ")}]`);
  }

  const stopPercent = Math.max(0.05, trend.atrPercent * tradeParams.stopMultiplier * 0.8);
  const targetPercent = Math.max(0.08, trend.atrPercent * tradeParams.targetMultiplier * 0.7);

  return {
    detected: true,
    side,
    mode: "swing_pullback",
    reason: `🔄 PULLBACK ${side}: ${reasons.join(", ")} str=${strength.toFixed(2)} tgt=${targetPercent.toFixed(3)}% stp=${stopPercent.toFixed(3)}% @$${price.toFixed(1)}`,
    strength,
    suggestedMinHoldSeconds: tradeParams.minHoldSeconds,
    stopPercent,
    targetPercent,
    hardMaxHoldSeconds: tradeParams.maxHoldSeconds,
    trailingStop: tradeParams.trailingStopEnabled ? {
      activationPercent: targetPercent * 0.5,
      trailPercent: targetPercent * 0.35,
    } : undefined,
    maxLossDollars: 25,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SIGNAL: SESSION BREAKOUT — London/NY opens
// Gold makes structural moves at session opens.
// ═══════════════════════════════════════════════════════════════════════

function detectSessionBreakout(
  candles1m: Candle[],
  candles5m: Candle[],
  trend: TrendAssessment,
  tradeParams: TradeParams,
  sessionInfo: { session: GoldSession; config: SessionConfig },
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
  safeHaven?: SafeHavenSignal,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });
  const price = candles1m[candles1m.length - 1].close;

  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const timeDecimal = utcHour + utcMinute / 60;

  const isLondonOpen = timeDecimal >= 3 && timeDecimal < 4;
  const isNYOpen = timeDecimal >= 13 && timeDecimal < 14.5;

  if (!isLondonOpen && !isNYOpen) {
    return noSignal("Not at session open");
  }

  if (candles5m.length < 5) return noSignal("Insufficient candles for session breakout");

  // Prior range
  const rangeCandles = candles5m.slice(-Math.min(12, candles5m.length));
  const rangeHigh = Math.max(...rangeCandles.map(c => c.high));
  const rangeLow = Math.min(...rangeCandles.map(c => c.low));
  const rangeSize = rangeHigh - rangeLow;
  const rangePct = price > 0 ? (rangeSize / price) * 100 : 0;

  if (rangePct > 0.50) {
    return noSignal(`Session breakout: prior range too wide (${rangePct.toFixed(3)}%)`);
  }

  // Breakout detection
  let side: "Long" | "Short" | null = null;
  const breakoutMargin = rangeSize * 0.10;

  if (price > rangeHigh + breakoutMargin) {
    side = "Long";
  } else if (price < rangeLow - breakoutMargin) {
    side = "Short";
  }

  if (!side) {
    return noSignal(`Session breakout: within range ($${rangeLow.toFixed(1)}-$${rangeHigh.toFixed(1)})`);
  }

  let strength = 0.30;
  const reasons: string[] = [isLondonOpen ? "London_open" : "NY_open"];
  reasons.push(`range=${rangePct.toFixed(3)}%`);

  // Volume confirmation
  if (candles1m.length >= 10) {
    const recentVols = candles1m.slice(-5).map(c => c.volume);
    const avgVolArr = candles1m.slice(-15, -5).map(c => c.volume);
    const avgVolVal = avgVolArr.length > 0 ? avgVolArr.reduce((a, b) => a + b, 0) / avgVolArr.length : 0;
    const currentVol = recentVols[recentVols.length - 1] || 0;
    const volRatio = avgVolVal > 0 ? currentVol / avgVolVal : 1;
    if (volRatio > 1.3) { strength += 0.10; reasons.push(`vol=${volRatio.toFixed(1)}x`); }
  }

  // MACD alignment
  if ((side === "Long" && trend.macd.histogram > 0) || (side === "Short" && trend.macd.histogram < 0)) {
    strength += 0.08;
    reasons.push("MACD_ok");
  }

  // Researcher
  if (briefDirective?.bias === (side === "Long" ? "long" : "short")) {
    strength += 0.10;
    reasons.push("bias_ok");
  }

  // Safe haven
  if (safeHaven?.active && side === "Long") {
    strength += safeHaven.strength * 0.10;
    reasons.push("safe_haven");
  }

  // OB
  if (orderbook && orderbook.strength > 0.15) {
    if ((orderbook.lean === "long" && side === "Long") || (orderbook.lean === "short" && side === "Short")) {
      strength += 0.06;
      reasons.push(`OB:${orderbook.ratio.toFixed(2)}`);
    }
  }

  strength = Math.max(0, Math.min(1.0, strength));

  if (strength < 0.30) {
    return noSignal(`Session breakout ${side}: weak (${strength.toFixed(2)})`);
  }

  const stopPercent = Math.max(0.06, rangePct * 0.5);
  const targetPercent = Math.max(0.12, rangePct * 1.0);

  return {
    detected: true,
    side,
    mode: "session_breakout",
    reason: `🌅 SESSION_BREAKOUT ${side}: ${reasons.join(", ")} str=${strength.toFixed(2)} tgt=${targetPercent.toFixed(3)}% stp=${stopPercent.toFixed(3)}% @$${price.toFixed(1)}`,
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
// SIGNAL: MOMENTUM BURST — Simple fast momentum for when gold moves
// Quick scalp on sudden moves with volume
// ═══════════════════════════════════════════════════════════════════════

function detectMomentumBurst(
  candles1m: Candle[],
  trend: TrendAssessment,
  tradeParams: TradeParams,
  sessionConfig: SessionConfig,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
  safeHaven?: SafeHavenSignal,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });
  const price = candles1m[candles1m.length - 1].close;

  if (candles1m.length < 5) return noSignal("Insufficient candles for momentum burst");

  // Look at last 3 candles for consecutive directional movement
  const last3 = candles1m.slice(-3);
  let consecutiveUp = 0;
  let consecutiveDown = 0;
  let totalMovePct = 0;

  for (const c of last3) {
    const move = c.close - c.open;
    const movePct = c.open > 0 ? (move / c.open) * 100 : 0;
    totalMovePct += movePct;
    if (move > 0) consecutiveUp++;
    else if (move < 0) consecutiveDown++;
  }

  // Need consecutive candles in same direction
  // Gold threshold: lower than BTC (config.strategy.momentumThreshold = 0.03)
  const threshold = config.strategy.momentumThreshold || 0.03;

  let side: "Long" | "Short" | null = null;

  if (consecutiveUp >= 2 && totalMovePct > threshold) {
    side = "Long";
  } else if (consecutiveDown >= 2 && totalMovePct < -threshold) {
    side = "Short";
  }

  if (!side) {
    return noSignal(`No momentum burst (up=${consecutiveUp} dn=${consecutiveDown} move=${totalMovePct.toFixed(4)}%)`);
  }

  // Don't chase too far — gold-specific max chase
  const maxChase = config.strategy.maxChasePercent || 0.15;
  if (Math.abs(totalMovePct) > maxChase) {
    return noSignal(`Momentum burst: too far to chase (${Math.abs(totalMovePct).toFixed(3)}% > ${maxChase}%)`);
  }

  // RSI shouldn't be extreme
  if (side === "Long" && trend.rsi > 72) return noSignal(`Momentum burst Long: RSI high (${trend.rsi.toFixed(0)})`);
  if (side === "Short" && trend.rsi < 28) return noSignal(`Momentum burst Short: RSI low (${trend.rsi.toFixed(0)})`);

  let strength = 0.20;
  const reasons: string[] = [`move=${totalMovePct.toFixed(3)}%`];

  // Momentum strength proportional to move size
  const moveMultiple = Math.abs(totalMovePct) / threshold;
  strength += Math.min(moveMultiple * 0.08, 0.20);

  // EMA alignment
  const emaAligned = (side === "Long" && trend.ema9 > trend.ema21) ||
                     (side === "Short" && trend.ema9 < trend.ema21);
  if (emaAligned) { strength += 0.08; reasons.push("EMA_ok"); }

  // MACD alignment
  if ((side === "Long" && trend.macd.histogram > 0) || (side === "Short" && trend.macd.histogram < 0)) {
    strength += 0.06;
    reasons.push("MACD_ok");
  }

  // Researcher alignment
  if (briefDirective?.bias === (side === "Long" ? "long" : "short")) {
    strength += 0.10 * (briefDirective.regimeConfidence || 0.5);
    reasons.push("bias_aligned");
  }

  // Safe haven
  if (safeHaven?.active && side === "Long") {
    strength += safeHaven.strength * 0.08;
    reasons.push("safe_haven");
  }

  // OB
  if (orderbook && orderbook.strength > 0.15) {
    if ((orderbook.lean === "long" && side === "Long") || (orderbook.lean === "short" && side === "Short")) {
      strength += 0.06;
      reasons.push(`OB:${orderbook.ratio.toFixed(2)}`);
    }
  }

  // Counter-trend penalty
  if (briefDirective?.bias && briefDirective.bias !== "neutral" &&
      briefDirective.bias !== (side === "Long" ? "long" : "short") &&
      briefDirective.regimeConfidence > 0.7) {
    strength *= 0.65;
    reasons.push("counter_bias");
  }

  // Session scaling
  strength *= sessionConfig.aggressionMultiplier;
  strength = Math.max(0, Math.min(1.0, strength));

  if (strength < tradeParams.minStrength) {
    return noSignal(`Momentum burst ${side}: weak (${strength.toFixed(2)}) [${reasons.join(", ")}]`);
  }

  // Quick scalp — tight stops and targets
  const stopPercent = Math.max(0.04, trend.atrPercent * 0.3);
  const targetPercent = Math.max(0.06, trend.atrPercent * 0.5);

  return {
    detected: true,
    side,
    mode: "momentum",
    reason: `⚡ MOMENTUM ${side}: ${reasons.join(", ")} str=${strength.toFixed(2)} tgt=${targetPercent.toFixed(3)}% stp=${stopPercent.toFixed(3)}% @$${price.toFixed(1)}`,
    strength,
    suggestedMinHoldSeconds: 60,
    stopPercent,
    targetPercent,
    hardMaxHoldSeconds: 1200,
    trailingStop: {
      activationPercent: targetPercent * 0.5,
      trailPercent: targetPercent * 0.4,
    },
    maxLossDollars: 20,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN EXPORTED FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * detectMomentum — Primary entry signal detector for gold futures.
 * v3.0: Gold-tuned with NO artificial blockers.
 *
 * KEY CHANGES FROM v2.0:
 *   1. NO brief staleness check (handled upstream)
 *   2. NO internal regime override (trusts researcher)
 *   3. NO hardcoded ATR minimums (0.03% ATR is normal for gold)
 *   4. LOWER strength thresholds (gold signals are subtler)
 *   5. ADDED momentum burst signal for quick scalps
 *   6. All signals run in parallel, best one wins
 */
export function detectMomentum(
  candles: Candle[],
  momentumThreshold: number = 0.03,
  maxChase: number = 0.15,
  briefDirective?: BriefDirective,
  orderbook?: OrderbookImbalance,
): MomentumSignal {
  const noSignal: MomentumSignal = { detected: false, reason: "No signal" };

  if (candles.length < 10) {
    return { ...noSignal, reason: `Insufficient candles: ${candles.length} (need 10)` };
  }

  // Session check
  const sessionInfo = getCurrentSession();
  const sessionCfg = sessionInfo.config;

  if (sessionInfo.session === "maintenance") {
    return { ...noSignal, reason: `⏸️ MAINTENANCE BREAK (22:00-23:00 UTC)` };
  }

  // Get regime from researcher — DO NOT OVERRIDE
  const regime = briefDirective?.regime || "unknown";
  const confidence = briefDirective?.regimeConfidence || 0.5;
  const tradeParams = getTradeParams(regime, confidence);

  // Build 5m candles from 1m
  const candles5m = aggregateCandles(candles, 5);

  // Assess trend from local candle data
  const trend = assessTrend(candles, briefDirective);

  // Safe haven detection
  const safeHaven