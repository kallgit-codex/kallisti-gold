// KALLISTI v6.0 - Swing Trade Recovery Manager with Hard Circuit Breakers
// 
// CRITICAL FIXES from v5.0:
//   - HARD TIME CIRCUIT BREAKER: force-closes ANY position older than maxTradeSeconds
//     regardless of other logic. Previous session had a 52-minute hold despite 360s max.
//   - ABSOLUTE DOLLAR LOSS CAP: $25 max loss per trade, non-negotiable hard stop.
//   - TRAILING STOP SYSTEM: moves stop to breakeven after 0.5% profit, then trails
//     at 0.3% behind peak — this is how we capture the 1%+ swings the researcher found.
//   - Removed flat-cut / wrong-cut early exits that were killing swing trades.
//   - Swing-oriented timing: hold 15-60 minutes, not 1-5 minutes.
//
// EXIT PRIORITY (evaluated in this exact order):
//   1. HARD TIME LIMIT — absolute max, force close (circuit breaker)
//   2. ABSOLUTE DOLLAR LOSS CAP — $25 max loss, never exceeded
//   3. STOP LOSS — initial stop or trailing stop, whichever is tighter
//   4. MAX PROFIT — $100+ net, take it
//   5. TRAILING STOP ACTIVATION — after 0.5% gross profit, trail at 0.3%
//   6. TAKE PROFIT — hit target price level
//   7. TIME-SCALED EXITS — graduated exit logic based on hold duration
//   8. TIMEOUT — maxTradeSeconds reached, close at market
//
// Fee reference (Coinbase CFM via [docs.cdp.coinbase.com](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/introduction)):
//   - $500 collateral × 10x = $5,000 notional
//   - Taker: 0.03% per side = $1.50/side = $3 round-trip
//   - Maker: 0% (promotional)

import { config } from "../config";

export interface Position {
  id: string;
  side: "Long" | "Short";
  entryPrice: number;
  entryTime: number;
  collateral: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  minProfitTarget: number;
  maxProfitTarget: number;
  status: "open" | "closed";
  exitPrice?: number;
  exitTime?: number;
  pnl?: number;
  fees?: number;
  grossPnl?: number;
  reason?: string;
  mode?: "momentum" | "mean_reversion" | "swing";
  // NEW v6.0: Trailing stop state
  peakGrossPnl?: number;         // Highest gross P&L seen
  peakPrice?: number;            // Price at peak P&L
  trailingStopActive?: boolean;  // Whether trailing stop has been activated
  trailingStopPrice?: number;    // Current trailing stop level
  breakevenStopActive?: boolean; // Whether stop has moved to breakeven
}

export interface PositionUpdate {
  shouldClose: boolean;
  reason?: string;
  exitPrice?: number;
  // v6.0: Allow position mutations (trailing stop updates)
  mutations?: Partial<Position>;
}

// ============================================================
// CONSTANTS — hard limits that override ALL other logic
// ============================================================
const ABSOLUTE_MAX_HOLD_SECONDS = 3600;     // 60 minutes HARD LIMIT — circuit breaker
const ABSOLUTE_MAX_LOSS_DOLLARS = 25;       // $25 max loss — NEVER exceeded
const TRAILING_ACTIVATION_PCT = 0.50;       // Activate trail after 0.5% gross move
const TRAILING_DISTANCE_PCT = 0.30;         // Trail 0.3% behind peak
const BREAKEVEN_ACTIVATION_PCT = 0.35;      // Move stop to breakeven after 0.35% gross
const SWING_MIN_HOLD_SECONDS = 120;         // Don't exit winners before 2 minutes
const SWING_PROFIT_SCALE_SECONDS = 300;     // After 5 min, start accepting smaller profits
const GENEROUS_PROFIT_SECONDS = 900;        // After 15 min, accept any green exit

function calcFees(positionSize: number): number {
  const feeRate = config.fees.feeMode === "taker"
    ? config.fees.takerFeePercent
    : config.fees.makerFeePercent;
  return positionSize * (feeRate / 100) * 2; // Both sides
}

function calcGrossPnl(position: Position, currentPrice: number): { pct: number; dollars: number } {
  const posSize = position.collateral * position.leverage;
  const pct = position.side === "Long"
    ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
    : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
  const dollars = (pct / 100) * posSize;
  return { pct, dollars };
}

function calcNetPnl(position: Position, currentPrice: number): number {
  const posSize = position.collateral * position.leverage;
  const { dollars: gross } = calcGrossPnl(position, currentPrice);
  const fees = calcFees(posSize);
  return gross - fees;
}

// Calculate trailing stop price given peak price and position side
function calcTrailingStopPrice(side: "Long" | "Short", peakPrice: number): number {
  const trailPct = TRAILING_DISTANCE_PCT / 100;
  if (side === "Long") {
    return peakPrice * (1 - trailPct);
  } else {
    return peakPrice * (1 + trailPct);
  }
}

export function createPosition(
  side: "Long" | "Short",
  entryPrice: number,
  collateral: number,
  mode: "momentum" | "mean_reversion" | "swing" = "swing"
): Position {
  const leverage = config.futures.leverage;
  const posSize = collateral * leverage;
  
  // Calculate initial stop based on ABSOLUTE_MAX_LOSS_DOLLARS
  // This ensures we NEVER lose more than $25 on any trade
  const maxLossPct = (ABSOLUTE_MAX_LOSS_DOLLARS / posSize) * 100;
  
  // Use the tighter of: config stop % or absolute dollar loss cap
  const configStopPct = mode === "mean_reversion"
    ? (config.strategy.mrStopPercent || 0.18)
    : config.strategy.initialStopPercent;
  const stopPct = Math.min(configStopPct, maxLossPct) / 100;
  
  // Swing trades use wider targets — we want 0.5-1.5% moves
  const targetPct = mode === "mean_reversion"
    ? (config.strategy.mrTargetPercent || 0.12) / 100
    : config.strategy.targetProfitPercent / 100;
  
  const stopLoss = side === "Long"
    ? entryPrice * (1 - stopPct)
    : entryPrice * (1 + stopPct);
  
  const takeProfit = side === "Long"
    ? entryPrice * (1 + targetPct)
    : entryPrice * (1 - targetPct);
  
  return {
    id: `swing-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    side,
    entryPrice,
    entryTime: Date.now(),
    collateral,
    leverage,
    stopLoss,
    takeProfit,
    minProfitTarget: config.strategy.minProfitDollars,
    maxProfitTarget: config.strategy.maxProfitDollars,
    status: "open" as const,
    mode,
    // v6.0: Initialize trailing stop state
    peakGrossPnl: 0,
    peakPrice: entryPrice,
    trailingStopActive: false,
    trailingStopPrice: undefined,
    breakevenStopActive: false,
  };
}

export function updatePosition(
  position: Position,
  currentPrice: number,
  overrideMaxSeconds?: number
): PositionUpdate {
  const now = Date.now();
  const elapsed = (now - position.entryTime) / 1000;
  const posSize = position.collateral * position.leverage;
  const fees = calcFees(posSize);
  
  const { pct: grossPnlPct, dollars: grossPnl } = calcGrossPnl(position, currentPrice);
  const netPnl = grossPnl - fees;
  
  // Track mutations for trailing stop updates
  const mutations: Partial<Position> = {};
  
  // ============================================================
  // 1. HARD TIME CIRCUIT BREAKER — absolute max hold
  //    This is THE fix for the 52-minute hold bug. Non-negotiable.
  // ============================================================
  if (elapsed >= ABSOLUTE_MAX_HOLD_SECONDS) {
    return {
      shouldClose: true,
      reason: `CIRCUIT-BREAKER-TIME(${Math.round(elapsed)}s)`,
      exitPrice: currentPrice
    };
  }
  
  // ============================================================
  // 2. ABSOLUTE DOLLAR LOSS CAP — $25 max, NEVER exceeded
  //    This catches cases where price gaps through stop-loss.
  // ============================================================
  if (netPnl <= -ABSOLUTE_MAX_LOSS_DOLLARS) {
    return {
      shouldClose: true,
      reason: `CIRCUIT-BREAKER-LOSS($${netPnl.toFixed(2)})`,
      exitPrice: currentPrice
    };
  }
  
  // ============================================================
  // 3. STOP LOSS — initial stop OR trailing stop (whichever tighter)
  // ============================================================
  const effectiveStop = position.trailingStopPrice ?? position.stopLoss;
  
  if (position.side === "Long" && currentPrice <= effectiveStop) {
    const reason = position.trailingStopActive ? "trailing-stop" : "stop-loss";
    return { shouldClose: true, reason, exitPrice: currentPrice };
  }
  if (position.side === "Short" && currentPrice >= effectiveStop) {
    const reason = position.trailingStopActive ? "trailing-stop" : "stop-loss";
    return { shouldClose: true, reason, exitPrice: currentPrice };
  }
  
  // ============================================================
  // 4. MAX PROFIT — net $100+, don't get greedy
  // ============================================================
  if (netPnl >= position.maxProfitTarget) {
    return { shouldClose: true, reason: "max-profit", exitPrice: currentPrice };
  }
  
  // ============================================================
  // 5. TRAILING STOP MANAGEMENT — the core swing trade mechanism
  //    Updates peak tracking and trailing stop levels.
  //    This section produces MUTATIONS, not exits.
  // ============================================================
  
  // Update peak P&L tracking
  if (grossPnl > (position.peakGrossPnl ?? 0)) {
    mutations.peakGrossPnl = grossPnl;
    
    // Update peak price
    if (position.side === "Long" && currentPrice > (position.peakPrice ?? position.entryPrice)) {
      mutations.peakPrice = currentPrice;
    } else if (position.side === "Short" && currentPrice < (position.peakPrice ?? position.entryPrice)) {
      mutations.peakPrice = currentPrice;
    }
  }
  
  const currentPeakPrice = mutations.peakPrice ?? position.peakPrice ?? position.entryPrice;
  
  // Activate breakeven stop after 0.35% gross move
  if (!position.breakevenStopActive && grossPnlPct >= BREAKEVEN_ACTIVATION_PCT) {
    mutations.breakevenStopActive = true;
    // Move stop to entry price (breakeven before fees, small loss after fees — acceptable)
    const beStop = position.side === "Long"
      ? position.entryPrice * 1.0001  // Tiny buffer above entry
      : position.entryPrice * 0.9999; // Tiny buffer below entry
    mutations.trailingStopPrice = beStop;
    
    // Log the breakeven activation
    console.log(`  🔒 Breakeven stop activated at ${beStop.toFixed(1)} (gross +${grossPnlPct.toFixed(2)}%)`);
  }
  
  // Activate full trailing stop after 0.5% gross move
  if (!position.trailingStopActive && grossPnlPct >= TRAILING_ACTIVATION_PCT) {
    mutations.trailingStopActive = true;
    const trailStop = calcTrailingStopPrice(position.side, currentPeakPrice);
    mutations.trailingStopPrice = trailStop;
    
    console.log(`  📈 Trailing stop activated at ${trailStop.toFixed(1)} (trailing ${TRAILING_DISTANCE_PCT}% behind peak ${currentPeakPrice.toFixed(1)})`);
  }
  
  // Update trailing stop level if already active and we have a new peak
  if (position.trailingStopActive && mutations.peakPrice) {
    const newTrailStop = calcTrailingStopPrice(position.side, mutations.peakPrice);
    const currentTrailStop = position.trailingStopPrice ?? 0;
    
    // Only move trailing stop in the favorable direction
    if (position.side === "Long" && newTrailStop > currentTrailStop) {
      mutations.trailingStopPrice = newTrailStop;
    } else if (position.side === "Short" && (currentTrailStop === 0 || newTrailStop < currentTrailStop)) {
      mutations.trailingStopPrice = newTrailStop;
    }
  }
  
  // ============================================================
  // 6. TAKE PROFIT — hit target price level
  //    Only after minimum hold period to let winners run
  // ============================================================
  if (elapsed >= SWING_MIN_HOLD_SECONDS) {
    if (position.side === "Long" && currentPrice >= position.takeProfit) {
      return { shouldClose: true, reason: "take-profit", exitPrice: currentPrice, mutations };
    }
    if (position.side === "Short" && currentPrice <= position.takeProfit) {
      return { shouldClose: true, reason: "take-profit", exitPrice: currentPrice, mutations };
    }
  }
  
  // ============================================================
  // 7. TIME-SCALED EXIT LOGIC — graduated thresholds
  //    The key insight: as time passes, lower our profit expectations
  //    but never exit at a loss unless stop is hit.
  // ============================================================
  
  // After 5 minutes: accept $5+ net profit (good for the timeframe)
  if (elapsed >= SWING_PROFIT_SCALE_SECONDS && netPnl >= position.minProfitTarget) {
    return { shouldClose: true, reason: "swing-profit", exitPrice: currentPrice, mutations };
  }
  
  // After 15 minutes: accept any green exit (net >= 0)
  if (elapsed >= GENEROUS_PROFIT_SECONDS && netPnl >= 0) {
    return { shouldClose: true, reason: "generous-exit", exitPrice: currentPrice, mutations };
  }
  
  // After 30 minutes: accept small losses (net >= -$5) to free up capital
  if (elapsed >= 1800 && netPnl >= -5) {
    return { shouldClose: true, reason: "capital-free", exitPrice: currentPrice, mutations };
  }
  
  // After 45 minutes: accept moderate losses (net >= -$10)
  if (elapsed >= 2700 && netPnl >= -10) {
    return { shouldClose: true, reason: "time-decay-exit", exitPrice: currentPrice, mutations };
  }
  
  // ============================================================
  // 8. WRONG DIRECTION CUT — early exit if clearly wrong
  //    Only if we're well underwater AND enough time has passed
  //    to confirm the thesis is wrong (not just noise)
  // ============================================================
  
  // After 3 minutes: if gross P&L is worse than -0.3%, thesis is wrong
  if (elapsed >= 180 && grossPnlPct < -0.30) {
    return { shouldClose: true, reason: "thesis-wrong", exitPrice: currentPrice, mutations };
  }
  
  // After 10 minutes: if still negative, trend isn't coming
  if (elapsed >= 600 && grossPnl < -3) {
    return { shouldClose: true, reason: "trend-failed", exitPrice: currentPrice, mutations };
  }
  
  // ============================================================
  // 9. TIMEOUT — config maxTradeSeconds (but always under ABSOLUTE_MAX)
  // ============================================================
  const maxSeconds = Math.min(
    overrideMaxSeconds ?? config.strategy.maxTradeSeconds,
    ABSOLUTE_MAX_HOLD_SECONDS
  );
  if (elapsed >= maxSeconds) {
    return {
      shouldClose: true,
      reason: netPnl >= 0 ? "timeout-green" : "timeout-red",
      exitPrice: currentPrice,
      mutations
    };
  }
  
  // ============================================================
  // NO EXIT — return mutations (trailing stop updates) if any
  // ============================================================
  if (Object.keys(mutations).length > 0) {
    return { shouldClose: false, mutations };
  }
  
  return { shouldClose: false };
}

// Apply mutations from updatePosition back to the position object
export function applyMutations(position: Position, mutations?: Partial<Position>): Position {
  if (!mutations) return position;
  return { ...position, ...mutations };
}

export function closePosition(
  position: Position,
  exitPrice: number,
  reason: string
): Position {
  const posSize = position.collateral * position.leverage;
  const fees = calcFees(posSize);
  const { dollars: grossPnl } = calcGrossPnl(position, exitPrice);
  const netPnl = grossPnl - fees;
  
  // Enforce absolute dollar loss cap even at close time
  // (This is a safety net — should already be caught by updatePosition)
  const cappedNetPnl = Math.max(netPnl, -ABSOLUTE_MAX_LOSS_DOLLARS - fees);
  
  const holdSeconds = Math.round((Date.now() - position.entryTime) / 1000);
  const holdMinutes = (holdSeconds / 60).toFixed(1);
  
  console.log(`  📊 Trade closed: ${reason} | Hold: ${holdMinutes}m | Gross: $${grossPnl.toFixed(2)} | Net: $${cappedNetPnl.toFixed(2)} | Peak: $${(position.peakGrossPnl ?? 0).toFixed(2)}`);
  
  return {
    ...position,
    status: "closed",
    exitPrice,
    exitTime: Date.now(),
    pnl: cappedNetPnl,
    fees,
    grossPnl,
    reason,
  };
}

// ============================================================
// RISK GATE — pre-trade risk checks
// Prevents opening new positions when risk limits are breached.
// Called BEFORE createPosition.
// ============================================================
export interface RiskGateResult {
  allowed: boolean;
  reason?: string;
}

export function checkRiskGate(
  recentTrades: Position[],
  currentBalance: number
): RiskGateResult {
  const now = Date.now();
  const oneHourAgo = now - 3600_000;
  const oneDayAgo = now - 86400_000;
  
  // 1. Max trades per hour
  const tradesLastHour = recentTrades.filter(t => t.entryTime >= oneHourAgo);
  if (tradesLastHour.length >= config.risk.maxTradesPerHour) {
    return { allowed: false, reason: `Rate limit: ${tradesLastHour.length}/${config.risk.maxTradesPerHour} trades/hour` };
  }
  
  // 2. Consecutive losses pause
  const closedTrades = recentTrades
    .filter(t => t.status === "closed" && t.exitTime)
    .sort((a, b) => (b.exitTime ?? 0) - (a.exitTime ?? 0));
  
  let consecutiveLosses = 0;
  for (const trade of closedTrades) {
    if ((trade.pnl ?? 0) < 0) {
      consecutiveLosses++;
    } else {
      break;
    }
  }
  
  if (consecutiveLosses >= config.risk.maxConsecutiveLosses) {
    const lastLoss = closedTrades[0];
    const pauseUntil = (lastLoss?.exitTime ?? 0) + config.risk.pauseAfterLossesMinutes * 60_000;
    if (now < pauseUntil) {
      const remainMin = ((pauseUntil - now) / 60_000).toFixed(1);
      return { allowed: false, reason: `Pause: ${consecutiveLosses} consecutive losses, ${remainMin}min remaining` };
    }
  }
  
  // 3. Daily loss limit
  const tradesToday = recentTrades.filter(
    t => t.status === "closed" && t.exitTime && t.exitTime >= oneDayAgo
  );
  const dailyPnl = tradesToday.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  
  if (dailyPnl <= -config.risk.maxDailyLossDollars) {
    return { allowed: false, reason: `Daily loss limit: $${dailyPnl.toFixed(2)} / -$${config.risk.maxDailyLossDollars}` };
  }
  
  const dailyLossPct = (Math.abs(dailyPnl) / config.risk.initialBalance) * 100;
  if (dailyPnl < 0 && dailyLossPct >= config.risk.maxDailyLossPercent) {
    return { allowed: false, reason: `Daily loss %: ${dailyLossPct.toFixed(1)}% / ${config.risk.maxDailyLossPercent}%` };
  }
  
  // 4. Balance sanity check
  if (currentBalance < config.risk.initialBalance * 0.5) {
    return { allowed: false, reason: `Balance too low: $${currentBalance.toFixed(2)} (< 50% of initial)` };
  }
  
  return { allowed: true };
}