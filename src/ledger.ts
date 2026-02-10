// Simple ledger for tracking balance and positions

import { readFile, writeFile } from "fs/promises";
import { config } from "./config";
import { Position, closePosition } from "./risk/recovery-manager";

export interface LedgerState {
  balance: number;
  initialBalance: number;
  dailyStartBalance: number;
  dailyPnl: number;
  consecutiveLosses: number;
  positions: Position[];
  lastReset: number;
  tradesThisHour: number;
  lastHourReset: number;
  pausedUntil?: number;
}

export class Ledger {
  state: LedgerState;
  
  constructor() {
    this.state = {
      balance: config.risk.initialBalance,
      initialBalance: config.risk.initialBalance,
      dailyStartBalance: config.risk.initialBalance,
      dailyPnl: 0,
      consecutiveLosses: 0,
      positions: [],
      lastReset: Date.now(),
      tradesThisHour: 0,
      lastHourReset: Date.now(),
    };
  }
  
  async load() {
    try {
      const data = await readFile(config.ledgerPath, "utf-8");
      this.state = JSON.parse(data);
    } catch (err) {
      // File doesn't exist yet, use defaults
      await this.save();
    }
  }
  
  async save() {
    await writeFile(
      config.ledgerPath,
      JSON.stringify(this.state, null, 2)
    );
  }
  
  get openPositions(): Position[] {
    return this.state.positions.filter(p => p.status === "open" || p.status === "recovery");
  }
  
  get closedPositions(): Position[] {
    return this.state.positions.filter(p => p.status === "closed");
  }
  
  get availableBalance(): number {
    const inPositions = this.openPositions.reduce(
      (sum, p) => sum + p.collateral,
      0
    );
    return this.state.balance - inPositions;
  }
  
  canOpenPosition(): { allowed: boolean; reason?: string } {
    // Check if paused
    if (this.state.pausedUntil && Date.now() < this.state.pausedUntil) {
      return {
        allowed: false,
        reason: `Paused until ${new Date(this.state.pausedUntil).toLocaleTimeString()}`,
      };
    }
    
    // Check max positions
    if (this.openPositions.length >= config.futures.maxPositions) {
      return {
        allowed: false,
        reason: `Max ${config.futures.maxPositions} positions open`,
      };
    }
    
    // Check daily loss limit
    if (this.state.dailyPnl <= -config.risk.maxDailyLossDollars) {
      return {
        allowed: false,
        reason: `Daily loss limit hit ($${this.state.dailyPnl.toFixed(2)})`,
      };
    }
    
    // Check trades per hour
    const now = Date.now();
    if (now - this.state.lastHourReset > 3600000) {
      // Reset hourly counter
      this.state.tradesThisHour = 0;
      this.state.lastHourReset = now;
    }
    
    if (this.state.tradesThisHour >= config.risk.maxTradesPerHour) {
      return {
        allowed: false,
        reason: `Max ${config.risk.maxTradesPerHour} trades/hour reached`,
      };
    }
    
    // Check available balance
    if (this.availableBalance < config.risk.riskPerTrade) {
      return {
        allowed: false,
        reason: `Insufficient balance ($${this.availableBalance.toFixed(2)})`,
      };
    }
    
    return { allowed: true };
  }
  
  async openPosition(position: Position) {
    this.state.positions.push(position);
    this.state.tradesThisHour++;
    this.state.balance -= position.collateral;
    await this.save();
  }
  
  async closePosition(positionId: string, exitPrice: number, reason: string) {
    const idx = this.state.positions.findIndex(p => p.id === positionId);
    if (idx === -1) return;
    
    const position = this.state.positions[idx];
    const closed = closePosition(position, exitPrice, reason);
    
    this.state.positions[idx] = closed;
    this.state.balance += closed.collateral + (closed.pnl || 0);
    this.state.dailyPnl += closed.pnl || 0;
    
    // Track consecutive losses
    if ((closed.pnl || 0) < 0) {
      this.state.consecutiveLosses++;
      
      // Pause if hit consecutive loss limit
      if (this.state.consecutiveLosses >= config.risk.maxConsecutiveLosses) {
        this.state.pausedUntil = Date.now() + (config.risk.pauseAfterLossesMinutes * 60 * 1000);
      }
    } else {
      this.state.consecutiveLosses = 0;
    }
    
    await this.save();
    return closed;
  }
  
  resetDaily() {
    this.state.dailyStartBalance = this.state.balance;
    this.state.dailyPnl = 0;
    this.state.consecutiveLosses = 0;
    this.state.lastReset = Date.now();
  }

  /** Soft reset — clear PnL counter so bot keeps trading. Called when loss limit triggers optimizer. */
  resetDailyPnl() {
    this.state.dailyPnl = 0;
    this.state.consecutiveLosses = 0;
    delete (this.state as any).pausedUntil;
  }
  
  get stats() {
    const closed = this.closedPositions;
    const wins = closed.filter(p => (p.pnl || 0) > 0).length;
    const losses = closed.filter(p => (p.pnl || 0) < 0).length;
    const winRate = closed.length > 0 ? (wins / closed.length * 100).toFixed(1) : "0.0";
    
    return {
      totalTrades: closed.length,
      wins,
      losses,
      winRate,
      dailyPnl: this.state.dailyPnl.toFixed(2),
      dailyPnlPercent: ((this.state.dailyPnl / this.state.dailyStartBalance) * 100).toFixed(2),
      consecutiveLosses: this.state.consecutiveLosses,
    };
  }
}


