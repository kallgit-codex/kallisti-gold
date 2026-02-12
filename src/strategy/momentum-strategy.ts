// KALLISTI GOLD v2.0 — CHAMPION STRATEGY
// Backtested: 13,226 hourly candles (Sep 2023 → Feb 2026)
// Result: +101.4% | PF 2.46 | 58.4% WR | 7.8% Max DD | 82% Monthly WR
//
// SIGNALS (long only):
//   1. TREND: EMA5 crosses above EMA34 + ADX > 18 + +DI > -DI + vol > 1.29x + RSI < 65
//   2. MOMENTUM: Green candle + close > EMA9 + MACD histogram flips positive + vol > 2x + ADX > 15
//
// EXITS:
//   - Stoploss: 4.95% (wide — let gold breathe)
//   - ROI table: 8.58% (0min), 5.15% (60min), 3.43% (120min), 1.72% (240min), 1.03% (480min)
//   - Trailing: 0.52% trail after 1.40% profit
//   - RSI > 75 (overbought exit)
//   - EMA5 crosses below EMA34 (trend reversal)
//
// KEY INSIGHT: Wide stops + high ROI targets + long-only = profitable gold trading.
// Gold is in a secular bull market. Don't short it.

import { config } from "../config";

// ═══════════════════════════════════════════════════════════════
// TYPES (compatible with existing server.ts / recovery-manager)
// ═══════════════════════════════════════════════════════════════

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
  volatility?: { atrPercent: number; range24hPercent?: number; dailyRange?: number };
  trendData?: { ema20Distance?: number; ema50Distance?: number; deathCross?: boolean; goldenCross?: boolean; atrPercent?: number; range24hPercent?: number };
  safeHaven?: { btcDrawdownPercent?: number; riskOff?: boolean };
}

export interface OrderbookImbalance {
  bidTotal: number;
  askTotal: number;
  ratio: number;
  lean: "long" | "short" | "neutral";
  strength: number;
}

// ═══════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS
// ═══════════════════════════════════════════════════════════════

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function rsi(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change; else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function adx(candles: Candle[], period: number = 14): { adx: number; plusDI: number; minusDI: number } {
  if (candles.length < period + 1) return { adx: 0, plusDI: 0, minusDI: 0 };

  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  const trs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }

  // Smoothed averages
  const n = Math.min(period, trs.length);
  let atr = trs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let plusDM = plusDMs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let minusDM = minusDMs.slice(0, n).reduce((a, b) => a + b, 0) / n;

  const dxValues: number[] = [];
  for (let i = n; i < trs.length; i++) {
    atr = (atr * (n - 1) + trs[i]) / n;
    plusDM = (plusDM * (n - 1) + plusDMs[i]) / n;
    minusDM = (minusDM * (n - 1) + minusDMs[i]) / n;

    const pdi = atr > 0 ? (plusDM / atr) * 100 : 0;
    const mdi = atr > 0 ? (minusDM / atr) * 100 : 0;
    const sum = pdi + mdi;
    if (sum > 0) dxValues.push(Math.abs(pdi - mdi) / sum * 100);
  }

  const plusDI = atr > 0 ? (plusDM / atr) * 100 : 0;
  const minusDI = atr > 0 ? (minusDM / atr) * 100 : 0;

  let adxVal = 0;
  if (dxValues.length >= n) {
    adxVal = dxValues.slice(0, n).reduce((a, b) => a + b, 0) / n;
    for (let i = n; i < dxValues.length; i++) {
      adxVal = (adxVal * (n - 1) + dxValues[i]) / n;
    }
  } else if (dxValues.length > 0) {
    adxVal = dxValues.reduce((a, b) => a + b, 0) / dxValues.length;
  }

  return { adx: adxVal, plusDI, minusDI };
}

function macdHistogram(closes: number[], fast = 12, slow = 26, signal = 9): { current: number; previous: number } {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(fastEma[i] - slowEma[i]);
  }
  const signalLine = ema(macdLine, signal);
  const hist: number[] = [];
  for (let i = 0; i < macdLine.length; i++) {
    hist.push(macdLine[i] - signalLine[i]);
  }
  return {
    current: hist[hist.length - 1] || 0,
    previous: hist.length > 1 ? hist[hist.length - 2] : 0,
  };
}

function volumeRatio(candles: Candle[], lookback: number = 20): number {
  if (candles.length < lookback + 1) return 1;
  const recent = candles.slice(-(lookback + 1), -1);
  const avgVol = recent.reduce((sum, c) => sum + c.volume, 0) / recent.length;
  const currentVol = candles[candles.length - 1].volume;
  return avgVol > 0 ? currentVol / avgVol : 1;
}

// ═══════════════════════════════════════════════════════════════
// CANDLE AGGREGATION (kept for compatibility)
// ═══════════════════════════════════════════════════════════════

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
      bucket = { time: thisBucketStart, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
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

// ═══════════════════════════════════════════════════════════════
// BRIEF PARSER (kept for compatibility)
// ═══════════════════════════════════════════════════════════════

export function parseBriefDirective(brief: any): BriefDirective {
  const defaults: BriefDirective = {
    momentumActive: true, meanReversionActive: true,
    aggression: 0.5, bias: "neutral", regime: "unknown", regimeConfidence: 0.5,
  };
  if (!brief || typeof brief !== "object") return defaults;
  try {
    const ms = brief.momentum_scalper || brief.momentumScalper || {};
    let bias: "long" | "short" | "neutral" = "neutral";
    const rawBias = brief.bias || ms.bias || "";
    if (typeof rawBias === "string") {
      const lb = rawBias.toLowerCase();
      if (lb.includes("short") || lb.includes("bear")) bias = "short";
      else if (lb.includes("long") || lb.includes("bull")) bias = "long";
    }
    return {
      ...defaults,
      bias,
      regime: (brief.regime || brief.market_regime || "unknown").toString().toLowerCase(),
      regimeConfidence: typeof brief.regime_confidence === "number" ? brief.regime_confidence : 0.5,
    };
  } catch { return defaults; }
}

// ═══════════════════════════════════════════════════════════════
// ORDERBOOK (kept for compatibility)
// ═══════════════════════════════════════════════════════════════

export function computeOrderbookImbalance(
  bids?: Array<{ price: number; size: number }>,
  asks?: Array<{ price: number; size: number }>
): OrderbookImbalance {
  return { bidTotal: 0, askTotal: 0, ratio: 1, lean: "neutral", strength: 0 };
}

// ═══════════════════════════════════════════════════════════════
// MAIN SIGNAL DETECTION — CHAMPION STRATEGY
// ═══════════════════════════════════════════════════════════════

export function detectMomentum(
  candles: Candle[],
  _momentumThreshold: number = 0.03,
  _maxChase: number = 0.15,
  briefDirective?: BriefDirective,
  _orderbook?: OrderbookImbalance,
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({ detected: false, reason });

  // Need at least 35 candles for EMA34 to stabilize
  if (candles.length < 35) {
    return noSignal(`Need 35+ candles, got ${candles.length}`);
  }

  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];

  // === INDICATORS ===
  const ema5 = ema(closes, config.strategy.emaFastPeriod || 5);
  const ema34 = ema(closes, config.strategy.emaSlowPeriod || 34);
  const ema9 = ema(closes, 9);  // For momentum signal
  
  const currentEma5 = ema5[ema5.length - 1];
  const prevEma5 = ema5[ema5.length - 2];
  const currentEma34 = ema34[ema34.length - 1];
  const prevEma34 = ema34[ema34.length - 2];
  const currentEma9 = ema9[ema9.length - 1];

  const currentRsi = rsi(closes, 14);
  const adxData = adx(candles, 14);
  const macd = macdHistogram(closes, 12, 26, 9);
  const volRatio = volumeRatio(candles, 20);

  // === LONG ONLY (shorts killed P&L in backtest) ===
  if (config.strategy.longOnly !== false) {
    // SIGNAL 1: TREND LONG
    // EMA5 crosses above EMA34 + ADX > threshold + +DI > -DI + volume + RSI not overbought
    const emaCrossUp = currentEma5 > currentEma34 && prevEma5 <= prevEma34;
    const adxStrong = adxData.adx > (config.strategy.adxThreshold || 18);
    const diPositive = adxData.plusDI > adxData.minusDI;
    const volOk = volRatio > (config.strategy.volumeMultiplier || 1.29);
    const rsiOk = currentRsi < (config.strategy.rsiEntryMax || 65);

    if (emaCrossUp && adxStrong && diPositive && volOk && rsiOk) {
      const strength = 0.50 + 
        Math.min((adxData.adx - 18) * 0.01, 0.15) +
        Math.min((volRatio - 1.29) * 0.10, 0.15) +
        (briefDirective?.bias === "long" ? 0.10 : 0);

      return {
        detected: true,
        side: "Long",
        mode: "swing_trend",
        reason: `📈 TREND LONG: EMA5/34 cross ↑ | ADX=${adxData.adx.toFixed(1)} +DI=${adxData.plusDI.toFixed(1)} -DI=${adxData.minusDI.toFixed(1)} | Vol=${volRatio.toFixed(2)}x | RSI=${currentRsi.toFixed(0)} | str=${strength.toFixed(2)} @$${price.toFixed(1)}`,
        strength: Math.min(strength, 1.0),
        suggestedMinHoldSeconds: (config.strategy.minHoldMinutes || 30) * 60,
        stopPercent: config.strategy.stoplossPercent || 4.95,
        targetPercent: config.strategy.roiTable?.[120] || 3.43,
        hardMaxHoldSeconds: (config.strategy.maxTradeMinutes || 720) * 60,
        trailingStop: {
          activationPercent: config.strategy.trailingOffsetPercent || 1.40,
          trailPercent: config.strategy.trailingStartPercent || 0.52,
        },
        maxLossDollars: 400,
      };
    }

    // SIGNAL 2: MOMENTUM LONG
    // Green candle + close > EMA9 + MACD histogram flips positive + high volume + ADX > 15
    const lastCandle = candles[candles.length - 1];
    const greenCandle = lastCandle.close > lastCandle.open;
    const aboveEma9 = price > currentEma9;
    const macdFlipUp = macd.current > 0 && macd.previous <= 0;
    const highVolume = volRatio > (config.strategy.macdVolumeThreshold || 2.0);
    const minAdx = adxData.adx > (config.strategy.momentumAdxMin || 15);

    if (greenCandle && aboveEma9 && macdFlipUp && highVolume && minAdx) {
      const strength = 0.45 +
        Math.min((volRatio - 2.0) * 0.08, 0.15) +
        Math.min((adxData.adx - 15) * 0.01, 0.10) +
        (briefDirective?.bias === "long" ? 0.10 : 0);

      return {
        detected: true,
        side: "Long",
        mode: "momentum",
        reason: `⚡ MOMENTUM LONG: MACD flip ↑ | Vol=${volRatio.toFixed(2)}x | ADX=${adxData.adx.toFixed(1)} | RSI=${currentRsi.toFixed(0)} | EMA9=$${currentEma9.toFixed(1)} | str=${strength.toFixed(2)} @$${price.toFixed(1)}`,
        strength: Math.min(strength, 1.0),
        suggestedMinHoldSeconds: (config.strategy.minHoldMinutes || 30) * 60,
        stopPercent: config.strategy.stoplossPercent || 4.95,
        targetPercent: config.strategy.roiTable?.[120] || 3.43,
        hardMaxHoldSeconds: (config.strategy.maxTradeMinutes || 720) * 60,
        trailingStop: {
          activationPercent: config.strategy.trailingOffsetPercent || 1.40,
          trailPercent: config.strategy.trailingStartPercent || 0.52,
        },
        maxLossDollars: 400,
      };
    }

    // === EXIT SIGNALS (checked by server.ts on open positions) ===
    // These are encoded in the "no signal" reason so server.ts can parse them
    const emaCrossDown = currentEma5 < currentEma34 && prevEma5 >= prevEma34;
    const rsiOverbought = currentRsi > (config.strategy.exitRsi || 75);
    
    if (emaCrossDown) {
      return noSignal(`EXIT_SIGNAL:ema_cross_down|EMA5/34 cross ↓ — close longs|RSI=${currentRsi.toFixed(0)}`);
    }
    if (rsiOverbought) {
      return noSignal(`EXIT_SIGNAL:rsi_overbought|RSI=${currentRsi.toFixed(0)} > ${config.strategy.exitRsi}|EMA5=$${currentEma5.toFixed(1)}`);
    }

    // No signal — provide diagnostic info
    const reasons: string[] = [];
    if (!emaCrossUp) reasons.push(`no_cross(EMA5=${currentEma5.toFixed(1)} EMA34=${currentEma34.toFixed(1)})`);
    if (!adxStrong) reasons.push(`ADX_low(${adxData.adx.toFixed(1)}<${config.strategy.adxThreshold})`);
    if (!volOk && !highVolume) reasons.push(`vol_low(${volRatio.toFixed(2)}x)`);
    if (!rsiOk) reasons.push(`RSI_high(${currentRsi.toFixed(0)})`);
    if (!macdFlipUp) reasons.push(`MACD_hist=${macd.current.toFixed(2)}`);

    return noSignal(`No entry: ${reasons.join(" | ")} @$${price.toFixed(1)}`);
  }

  return noSignal("Strategy not configured");
}
