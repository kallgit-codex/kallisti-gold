// Brief Reader v3 — GOLD FUTURES
// Reads gold market briefs from kallisti-gold data branch
// Returns parameter overrides based on gold regime analysis
// NO LLM calls — pure deterministic logic
//
// GOLD at 10x/$3 fees is MUCH more forgiving than BTC at 75x/$30 fees.
// Breakeven is only 0.06% move. Be more permissive.

import { config } from "./config";
import { log } from "./logger";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const BRIEF_URL = "https://api.github.com/repos/kallgit-codex/kallisti-gold/contents/data/market-brief.json?ref=data";
const REFRESH_MS = 5 * 60 * 1000; // Re-fetch every 5 min

export interface MarketBrief {
  timestamp: number;
  generatedAt?: string;
  price: number;
  regime: string;
  regimeConfidence: number;
  regimeReason?: string;
  volatility: { atr_1h_pct: number; atr_15m_pct?: number; level: string };
  trend: { direction: string; priceVsEma20: number; priceVsEma50?: number };
  orderbook: { imbalance: number; bias: string; bidDepthUsd?: number; askDepthUsd?: number };
  stats24h?: { change: number; high: number; low: number; volume: number; range: number };
  news?: { sentiment: string; riskEventCount: number };
  recommendations: {
    momentum_scalper: {
      active: boolean;
      reason?: string;
      bias?: string;
      aggression?: string;
      params?: {
        bias?: string;
        aggression?: string;
        momentumThreshold?: number;
        maxTradeSeconds?: number;
      };
    };
    mean_reversion?: {
      active: boolean;
      reason?: string;
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
      if (fresh.regime !== lastRegime) {
        const stableSince = lastRegime === "" ? fresh.timestamp : now;
        log(`📊 REGIME CHANGED: ${lastRegime || "none"} → ${fresh.regime.toUpperCase()} (${(fresh.regimeConfidence * 100).toFixed(0)}%) — ${fresh.regimeReason || "no reason"}`);
        regimeStableSince = stableSince;
        lastRegime = fresh.regime;
      }
      cachedBrief = fresh;
      lastFetch = now;
    }
  }

  // No brief? Trade with defaults — gold at 10x/$3 fees is safe enough
  // Don't block trading just because the researcher is slow
  if (!cachedBrief) {
    return {
      tradingEnabled: true,
      reason: "⚠️ No brief available — trading with config defaults",
    };
  }

  const brief = cachedBrief;
  const rec = brief.recommendations.momentum_scalper;

  // Brief too old (>30min) — still trade but with defaults
  // Gold at $3 fees is forgiving enough to trade without fresh intel
  if (now - brief.timestamp > 30 * 60 * 1000) {
    return {
      tradingEnabled: true,
      reason: "⚠️ Brief stale (>30min) — trading with config defaults",
    };
  }

  // Check CME maintenance break (22:00-23:00 UTC)
  const utcHour = new Date().getUTCHours();
  if (utcHour === 22) {
    return {
      tradingEnabled: false,
      reason: "⛔ CME maintenance break (22:00-23:00 UTC)",
    };
  }

  // ============================================================
  // REGIME-BASED TUNING
  // Gold at 10x leverage with $3 fees = very forgiving.
  // We WANT to trade in most conditions. Only block during
  // maintenance or extreme conditions.
  // ============================================================

  const regime = (brief.regime || "unknown").toLowerCase().replace(/[\s-]+/g, "_");
  const confidence = brief.regimeConfidence || 0.5;
  const atr = brief.volatility?.atr_1h_pct || 0;
  const bias = rec.bias || rec.params?.bias || brief.trend?.direction || "neutral";

  // TRENDING BULLISH/BEARISH — our best edge, trade aggressively
  if (regime.includes("trending") || regime.includes("bull") || regime.includes("bear")) {
    const side = (regime.includes("bull") || regime.includes("bullish")) ? "Long" : 
                 (regime.includes("bear") || regime.includes("bearish")) ? "Short" : null;
    
    return {
      tradingEnabled: true,
      reason: `✅ ${regime.toUpperCase()} (${(confidence * 100).toFixed(0)}%) — ATR ${atr.toFixed(2)}%`,
      preferredSide: side as "Long" | "Short" | null,
      maxChasePercent: 0.20,        // Allow more chase in trends
      maxTradeSeconds: 5400,        // Let winners run in gold trends
      minProfitDollars: 3,          // Low bar — $3 fees mean even small wins count
    };
  }

  // HIGH VOL CHOP — tradeable at gold's fee structure, just be careful
  if (regime.includes("chop") || regime.includes("high_vol")) {
    return {
      tradingEnabled: true,
      reason: `✅ ${regime.toUpperCase()} — chop is tradeable at $3 fees (ATR ${atr.toFixed(2)}%)`,
      preferredSide: null,          // Both directions
      momentumThreshold: 0.04,      // Higher bar in chop
      maxTradeSeconds: 1800,        // Shorter holds in chop
      quickExitSeconds: 90,         // Grab profits faster
      quickGrabDollars: 4,          // Take $4+ in chop
      maxChasePercent: 0.10,        // Don't chase in chop
    };
  }

  // RANGING / SIDEWAYS — mean reversion territory
  if (regime.includes("rang") || regime.includes("sideways") || regime.includes("squeeze")) {
    return {
      tradingEnabled: true,
      reason: `✅ ${regime.toUpperCase()} — mean reversion mode (ATR ${atr.toFixed(2)}%)`,
      preferredSide: null,
      momentumThreshold: 0.05,      // Need stronger signals in range
      maxTradeSeconds: 1200,        // Medium holds
      quickExitSeconds: 120,
      quickGrabDollars: 3,
      maxChasePercent: 0.08,
    };
  }

  // UNKNOWN / OTHER — trade conservatively but don't block
  return {
    tradingEnabled: true,
    reason: `⚠️ Regime "${regime}" — trading conservatively`,
    momentumThreshold: 0.04,
    maxTradeSeconds: 1800,
    quickGrabDollars: 4,
  };
}

// For logging/health endpoint
export function getCurrentBrief(): MarketBrief | null {
  return cachedBrief;
}
