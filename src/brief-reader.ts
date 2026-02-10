// Brief Reader v2 - Consumes market briefs from the research agent
// Reads data/market-brief.json from GitHub data branch every 5 minutes
// Returns parameter overrides for the scalper based on regime analysis
// NO LLM calls — pure deterministic logic
//
// v2 CHANGES (Opus 4.6 recommendations):
//   - high_vol_chop → BLOCK trading entirely (was: conservative mode)
//   - ranging/low_vol_squeeze → BLOCK trading (momentum doesn't work here)
//   - trending regimes → trade but with confidence gating
//   - Regime must be stable 15+ min before acting on it
//   - Stale brief (>20min) → pause, not trade with defaults

import { config } from "./config";
import { log } from "./logger";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const BRIEF_URL = "https://api.github.com/repos/kallgit-codex/kallisti-scalper/contents/data/market-brief.json?ref=data";
const REFRESH_MS = 5 * 60 * 1000; // Re-fetch every 5 min

export interface MarketBrief {
  timestamp: number;
  generatedAt: string;
  price: number;
  regime: string;
  regimeConfidence: number;
  regimeReason: string;
  volatility: { atr_1h_pct: number; level: string };
  trend: { direction: string; priceVsEma20: number };
  orderbook: { imbalance: number; bias: string };
  news: { sentiment: string; riskEventCount: number };
  recommendations: {
    momentum_scalper: {
      active: boolean;
      reason: string;
      params?: {
        bias?: string;
        aggression?: string;
        momentumThreshold?: number;
        maxTradeSeconds?: number;
      };
    };
  };
}

export interface ScalperOverrides {
  tradingEnabled: boolean;
  reason: string;
  momentumThreshold?: number;
  maxTradeSeconds?: number;
  maxChasePercent?: number;
  quickExitSeconds?: number;
  quickGrabDollars?: number;
  minProfitDollars?: number;
  preferredSide?: "Long" | "Short" | null;
}

let cachedBrief: MarketBrief | null = null;
let lastFetch = 0;
let lastRegime = "";
let regimeStableSince = 0;

async function fetchBrief(): Promise<MarketBrief | null> {
  if (!GITHUB_TOKEN) return null;

  try {
    const resp = await fetch(BRIEF_URL, {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (!resp.ok) return null;

    const data: any = await resp.json();
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return JSON.parse(content) as MarketBrief;
  } catch (err) {
    log(`⚠️  Brief fetch failed: ${err}`);
    return null;
  }
}

export async function getOverrides(): Promise<ScalperOverrides> {
  const now = Date.now();
  if (!cachedBrief || now - lastFetch > REFRESH_MS) {
    const fresh = await fetchBrief();
    if (fresh) {
      // Track regime stability
      if (fresh.regime !== lastRegime) {
        // On first load (no previous regime), use brief's own timestamp as baseline
        // so we don't restart the stability clock on every deploy
        const stableSince = lastRegime === "" ? fresh.timestamp : now;
        log(`📊 REGIME CHANGED: ${lastRegime || "none"} → ${fresh.regime.toUpperCase()} (${(fresh.regimeConfidence * 100).toFixed(0)}%) — ${fresh.regimeReason}`);
        regimeStableSince = stableSince;
        lastRegime = fresh.regime;
      }
      cachedBrief = fresh;
      lastFetch = now;
    }
  }

  // No brief available — DON'T trade blind
  if (!cachedBrief) {
    return { tradingEnabled: false, reason: "⛔ No market brief — refusing to trade blind" };
  }

  const brief = cachedBrief;
  const rec = brief.recommendations.momentum_scalper;

  // Brief too old (>20min) — data is stale, sit out
  if (now - brief.timestamp > 20 * 60 * 1000) {
    return { tradingEnabled: false, reason: "⛔ Brief stale (>20min) — sitting out" };
  }

  // Research agent explicitly says sit out
  if (!rec.active) {
    return { tradingEnabled: false, reason: `⛔ ${rec.reason}` };
  }

  // REGIME GATING — the core decision
  const regime = brief.regime;
  const confidence = brief.regimeConfidence;
  const regimeAgeMin = (now - regimeStableSince) / 60000;

  // ============================================================
  // CHOP / RANGING = NO TRADE for momentum scalper
  // Opus 4.6: "Is momentum scalping viable at 75x with taker fees
  // in a chop regime? The math says no."
  // ============================================================
  if (regime === "high_vol_chop") {
    // v4.3: Block chop trading during active corrections.
    // Evidence: 6/6 trades lost in high_vol_chop with -2.5% 24h change.
    // In selloffs, 'chop' is distribution noise — momentum signals catch
    // the peak of short oscillations, then price reverts. Not tradeable.
    const briefAny = brief as any;
    const change24h = Math.abs(briefAny.stats24h?.change || 0);
    if (change24h > 2.0) {
      return {
        tradingEnabled: false,
        reason: `⛔ HIGH_VOL_CHOP during correction (24h: ${briefAny.stats24h?.change?.toFixed(1) || '?'}%) — distribution noise, not tradeable`,
      };
    }

    // v4.1: At Coinbase CFM $3 fees, calm chop IS viable for quick scalps.
    // Breakeven is only 0.06% — high ATR means plenty of 0.10%+ moves.
    // But ONLY when market is range-bound (24h change < 2%).
    const overrides: ScalperOverrides = {
      tradingEnabled: true,
      reason: `✅ HIGH_VOL_CHOP — selective scalps at $3 fees (ATR ${brief.volatility.atr_1h_pct.toFixed(2)}%)`,
      preferredSide: null,  // Both directions in chop
      // v4.3: Raised to 0.25%. Evidence: 6/6 losses at 0.20% threshold.
      // In chop, 0.20% moves are the PEAK of oscillations, not the start.
      // 0.25% ensures we only enter outsized moves that have continuation potential.
      momentumThreshold: Math.max(0.25, rec.params?.momentumThreshold || 0.10, config.strategy.momentumThreshold),
      maxTradeSeconds: 90,   // Shorter holds — 120s was too long, all 6 trades timed out red
      quickExitSeconds: 20,  // Grab profits very fast in chop
      quickGrabDollars: 5,   // $5 net = 0.16% gross — take any win in chop
      maxChasePercent: 0.15, // Don't chase in chop
      minProfitDollars: 6,   // $6 net = ~0.18% gross — lower bar to lock in wins
    };

    // Risk overlay still applies
    if (brief.news.riskEventCount >= 6) {
      return {
        tradingEnabled: false,
        reason: `⛔ HIGH_VOL_CHOP + ${brief.news.riskEventCount} risk events — too dangerous`,
      };
    }
    if (brief.news.riskEventCount >= 4) {
      overrides.momentumThreshold = Math.max(overrides.momentumThreshold || 0.10, 0.15);
      overrides.reason += ` | ⚠️ ${brief.news.riskEventCount} risk events`;
    }

    return overrides;
  }

  if (regime === "ranging" || regime === "low_vol_squeeze") {
    return {
      tradingEnabled: false,
      reason: `⛔ ${regime.toUpperCase()} — no directional edge, waiting for trend`,
    };
  }

  // ============================================================
  // TRENDING = TRADE (our edge)
  // But require confidence > 60% and regime stable for 15+ min
  // ============================================================
  if (regime === "trending_bullish" || regime === "trending_bearish") {
    // Low confidence — don't trust the call
    if (confidence < 0.70) {
      return {
        tradingEnabled: false,
        reason: `⛔ ${regime} but only ${(confidence * 100).toFixed(0)}% confidence — need 70%+`,
      };
    }

    // Weak trend — price barely above/below EMA20
    const emaDistance = Math.abs(brief.trend.priceVsEma20);
    // v4.1: Lowered from 0.30% to 0.15%. At 10x/$3 fees, entering slightly earlier
    // is fine — max risk is $15.50/trade. The old 0.30% blocked entries where BTC
    // was +2.5% 24h at 85% confidence but only 0.16% from EMA20.
    if (emaDistance < 0.15) {
      return {
        tradingEnabled: false,
        reason: `⛔ ${regime} but EMA20 distance only ${emaDistance.toFixed(2)}% — need 0.15%+ for conviction`,
      };
    }

    // Regime just changed — wait for stability (Opus: "regime hysteresis")
    if (regimeAgeMin < 15) {
      return {
        tradingEnabled: false,
        reason: `⛔ ${regime} but only ${regimeAgeMin.toFixed(0)}min old — waiting for 15min stability`,
      };
    }

    // Green light — trade in direction of trend
    const overrides: ScalperOverrides = {
      tradingEnabled: true,
      reason: `✅ ${regime.toUpperCase()} (${(confidence * 100).toFixed(0)}%, ${regimeAgeMin.toFixed(0)}min stable)`,
      preferredSide: regime === "trending_bullish" ? "Long" : "Short",
      maxChasePercent: 0.35,        // Allow more chase in trends
      minProfitDollars: 8,          // At 10x: $8 net = $11 gross = 0.22% move
    };

    // Apply research agent's recommended params if provided
    // FLOOR: brief can RAISE threshold but never LOWER it below config base
    if (rec.params?.momentumThreshold) {
      overrides.momentumThreshold = Math.max(rec.params.momentumThreshold, config.strategy.momentumThreshold);
    }
    if (rec.params?.maxTradeSeconds) {
      overrides.maxTradeSeconds = rec.params.maxTradeSeconds;
    }

    // CANDLE RATIO SANITY CHECK: If recent 1m candles contradict trend, block
    // This catches intraday reversals the regime classification misses
    const briefAny = brief as any;
    const candles1m = briefAny.recentCandles?.find((c: any) => c.interval === '1m');
    if (candles1m && candles1m.count >= 8) {
      const bearishRatio = candles1m.bearish / candles1m.count;
      const bullishRatio = candles1m.bullish / candles1m.count;
      if (regime === 'trending_bullish' && bearishRatio > 0.65) {
        return {
          tradingEnabled: false,
          reason: `⛔ ${regime} but 1m candles are ${(bearishRatio * 100).toFixed(0)}% bearish (${candles1m.bearish}/${candles1m.count}) — intraday reversal signal`,
        };
      }
      if (regime === 'trending_bearish' && bullishRatio > 0.65) {
        return {
          tradingEnabled: false,
          reason: `⛔ ${regime} but 1m candles are ${(bullishRatio * 100).toFixed(0)}% bullish (${candles1m.bullish}/${candles1m.count}) — intraday reversal signal`,
        };
      }
    }

    // ORDERBOOK SANITY CHECK: Don't go long into heavy sell pressure or short into heavy buy pressure
    const obBias = brief.orderbook.bias;
    const obImbalance = Math.abs(brief.orderbook.imbalance);
    
    // SEVERE contradiction (>0.55): OB is extremely against trend — BLOCK
    // v3.5: Raised from 0.25 to 0.55. During trending moves, moderate ask_heavy is NORMAL
    // (sellers selling into strength). Only block when OB is overwhelmingly one-sided.
    // Evidence: 3hr session where price went UP 1% while OB was ask_heavy 0.36-0.64.
    if (obImbalance > 0.55) {
      if (regime === "trending_bullish" && obBias === "ask_heavy") {
        return {
          tradingEnabled: false,
          reason: `⛔ ${regime} but extreme ask-heavy OB (${obImbalance.toFixed(2)}) — supply wall blocks longs`,
        };
      }
      if (regime === "trending_bearish" && obBias === "bid_heavy") {
        return {
          tradingEnabled: false,
          reason: `⛔ ${regime} but extreme bid-heavy OB (${obImbalance.toFixed(2)}) — demand wall blocks shorts`,
        };
      }
    }
    
    // MODERATE contradiction (>0.40): raise threshold but don't block
    if (obImbalance > 0.40) {
      if (regime === "trending_bullish" && obBias === "ask_heavy") {
        overrides.momentumThreshold = Math.max(overrides.momentumThreshold || config.strategy.momentumThreshold, 0.18);
        overrides.reason += ` | ⚠️ Ask-heavy OB (${obImbalance.toFixed(2)}) — raised threshold to 0.18`;
      }
      if (regime === "trending_bearish" && obBias === "bid_heavy") {
        overrides.momentumThreshold = Math.max(overrides.momentumThreshold || config.strategy.momentumThreshold, 0.18);
        overrides.reason += ` | ⚠️ Bid-heavy OB (${obImbalance.toFixed(2)}) — raised threshold to 0.18`;
      }
    }

    // Risk overlay: news risk = tighten or block
    if (brief.news.riskEventCount >= 6) {
      // 6+ risk events = too much uncertainty for leveraged scalping
      return {
        tradingEnabled: false,
        reason: `⛔ ${brief.news.riskEventCount} risk events — too dangerous for leveraged scalping`,
      };
    }
    if (brief.news.riskEventCount >= 4) {
      // v3.5: Raised from 3→4. Crypto always has 2-3 risk headlines.
      overrides.momentumThreshold = Math.max(overrides.momentumThreshold || 0.12, 0.18);
      overrides.maxTradeSeconds = Math.min(overrides.maxTradeSeconds || 180, 150);
      overrides.reason += ` | ⚠️ ${brief.news.riskEventCount} risk events — raised threshold to 0.18`;
    }

    return overrides;
  }

  // Unknown regime — don't trade
  return {
    tradingEnabled: false,
    reason: `⛔ Unknown regime "${regime}" — sitting out`,
  };
}

// For logging/health endpoint
export function getCurrentBrief(): MarketBrief | null {
  return cachedBrief;
}
