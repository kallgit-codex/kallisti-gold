// Coinbase Advanced Trade Market Data Client — GOLD FUTURES
// Drop-in replacement for BinanceClient
// Handles: candles, ticker, orderbook, products, positions
//
// Product naming: Coinbase CFM uses "GLD-{date}-CDE" for Gold futures
// We auto-discover the active gold contract on startup

import { CoinbaseAuthConfig, getAuthHeader } from "./coinbase-auth";
import { log, error } from "../logger";

export interface CoinbaseCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CoinbaseTicker {
  price: number;
  bid: number;
  ask: number;
  volume24h: number;
  priceChange24h: number;
}

export interface CoinbaseProduct {
  product_id: string;
  price: string;
  base_currency_id: string;
  quote_currency_id: string;
  product_type: string;
  fcm_trading_session_details?: any;
}

export interface CFMPosition {
  product_id: string;
  side: string;
  number_of_contracts: string;
  current_price: string;
  avg_entry_price: string;
  unrealized_pnl: string;
  expiration_time: string;
}

export interface CFMBalance {
  total_usd_balance: string;
  futures_buying_power: string;
  unrealized_pnl: string;
  available_margin: string;
  intraday_margin_setting: string;
}

// Coinbase granularity enum for candles
type Granularity = "ONE_MINUTE" | "FIVE_MINUTE" | "FIFTEEN_MINUTE" | "THIRTY_MINUTE" | "ONE_HOUR" | "TWO_HOUR" | "SIX_HOUR" | "ONE_DAY";

const INTERVAL_MAP: Record<string, Granularity> = {
  "1m": "ONE_MINUTE",
  "5m": "FIVE_MINUTE", 
  "15m": "FIFTEEN_MINUTE",
  "30m": "THIRTY_MINUTE",
  "1h": "ONE_HOUR",
  "2h": "TWO_HOUR",
  "6h": "SIX_HOUR",
  "1d": "ONE_DAY",
};

export class CoinbaseClient {
  private baseUrl: string;
  private auth: CoinbaseAuthConfig;
  private activeProductId: string | null = null;
  
  constructor(
    auth: CoinbaseAuthConfig,
    baseUrl: string = "https://api.coinbase.com"
  ) {
    this.auth = auth;
    this.baseUrl = baseUrl;
  }
  
  private async request(method: string, path: string, body?: any): Promise<any> {
    const authHeader = await getAuthHeader(this.auth, method, path);
    
    const options: RequestInit = {
      method,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
    };
    
    if (body) {
      options.body = JSON.stringify(body);
    }
    
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const errText = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((v: string, k: string) => { headers[k] = v; });
      console.error("Coinbase error details:", JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        body: errText.substring(0, 500),
        headers,
        requestPath: path,
        requestMethod: method,
      }, null, 2));
      throw new Error(`Coinbase ${method} ${path} → ${response.status}: ${errText}`);
    }
    
    return response.json();
  }
  
  /**
   * Discover the active Gold futures contract
   * Coinbase CFM naming: GLD-{date}-CDE for Gold futures
   */
  async discoverFuturesProduct(): Promise<string> {
    if (this.activeProductId) return this.activeProductId;
    
    const data = await this.request("GET", "/api/v3/brokerage/products?product_type=FUTURE");
    const products = data.products || [];
    
    // Log ALL gold-related products for visibility
    const goldProducts = products.filter((p: any) => {
      const id = (p.product_id || "").toUpperCase();
      return id.startsWith("GLD-");
    });
    
    log(`🥇 Gold futures products (${goldProducts.length} found):`);
    for (const p of goldProducts) {
      log(`   ${p.product_id} status=${p.status} disabled=${p.trading_disabled} base=${p.base_currency_id}`);
    }
    
    if (goldProducts.length === 0) {
      log("🥇 No Gold products found. All futures:");
      for (const p of products.slice(0, 20)) {
        log(`   ${p.product_id} status=${p.status} disabled=${p.trading_disabled} base=${p.base_currency_id}`);
      }
      throw new Error("No Gold futures found. Products: " + 
        products.slice(0, 15).map((p: any) => p.product_id).join(", "));
    }
    
    // Priority 1: Online + tradeable GLD
    const online = goldProducts.filter((p: any) => 
      p.status === "online" && p.trading_disabled !== true
    );
    
    if (online.length > 0) {
      this.activeProductId = online[0].product_id;
      log(`🥇 Active Gold futures: ${this.activeProductId} (${online.length} online)`);
      return this.activeProductId;
    }
    
    // Priority 2: For paper mode, accept any BIT/BIP even if not "online"
    // (we only need price data, not actual execution)
    // Parse dates from product IDs: BIT-27FEB26-CDE → 2026-02-27
    const MONTHS: Record<string, number> = { JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5, JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11 };
    const parseDate = (id: string): number => {
      const m = id.match(/-(\d{2})([A-Z]{3})(\d{2})-/);
      if (!m) return Infinity;
      return new Date(2000 + parseInt(m[3]), MONTHS[m[2]] ?? 0, parseInt(m[1])).getTime();
    };
    const nearest = goldProducts
      .filter((p: any) => (p.product_id || "").startsWith("GLD-"))
      .sort((a: any, b: any) => parseDate(a.product_id) - parseDate(b.product_id));
    
    if (nearest.length > 0) {
      this.activeProductId = nearest[0].product_id;
      log(`📊 Gold futures (paper fallback): ${this.activeProductId} status=${nearest[0].status}`);
      return this.activeProductId;
    }
    
    // Priority 3: Any BTC product at all
    this.activeProductId = goldProducts[0].product_id;
    log(`📊 Gold futures (any): ${this.activeProductId} status=${goldProducts[0].status}`);
    return this.activeProductId;
  }
  
  /**
   * Get candles (OHLCV) — matches BinanceClient.getKlines() output format
   * Returns raw arrays compatible with normalizeCandles()
   */
  async getKlines(symbol: string, interval: string, limit: number = 50): Promise<{ list: any[] }> {
    const productId = await this.discoverFuturesProduct();
    const granularity = INTERVAL_MAP[interval] || "ONE_MINUTE";
    
    // Coinbase candles endpoint uses start/end timestamps
    const end = Math.floor(Date.now() / 1000);
    const intervalSeconds = this.getIntervalSeconds(interval);
    const start = end - (limit * intervalSeconds);
    
    const path = `/api/v3/brokerage/products/${productId}/candles?start=${start}&end=${end}&granularity=${granularity}`;
    const data = await this.request("GET", path);
    
    // Debug: log raw candle response shape
    const rawCandles = data.candles || data.candle || [];
    if (rawCandles.length === 0) {
      log("⚠️ Empty candles from " + productId + " | Response keys: " + Object.keys(data).join(",") + " | Raw: " + JSON.stringify(data).substring(0, 200));
    }
    
    // Coinbase returns: { candles: [{ start, low, high, open, close, volume }] }
    // Convert to Binance kline format: [openTime, open, high, low, close, volume, ...]
    const candles = (data.candles || [])
      .map((c: any) => [
        parseInt(c.start) * 1000,  // openTime (ms)
        c.open,                     // open
        c.high,                     // high
        c.low,                      // low
        c.close,                    // close
        c.volume,                   // volume
      ])
      .sort((a: any, b: any) => a[0] - b[0])  // Sort chronologically (Coinbase returns newest first)
      .slice(-limit);  // Limit to requested count
    
    return { list: candles };
  }
  
  /**
   * Get current ticker (best bid/ask + last price)
   */
  async getTicker(): Promise<CoinbaseTicker> {
    const productId = await this.discoverFuturesProduct();
    
    const [bidAsk, product] = await Promise.all([
      this.request("GET", `/api/v3/brokerage/best_bid_ask?product_ids=${productId}`),
      this.request("GET", `/api/v3/brokerage/products/${productId}`),
    ]);
    
    const pricebook = (bidAsk.pricebooks || [])[0] || {};
    const bestBid = pricebook.bids?.[0]?.price || "0";
    const bestAsk = pricebook.asks?.[0]?.price || "0";
    
    return {
      price: parseFloat(product.price || "0"),
      bid: parseFloat(bestBid),
      ask: parseFloat(bestAsk),
      volume24h: parseFloat(product.volume_24h || "0"),
      priceChange24h: parseFloat(product.price_percentage_change_24h || "0"),
    };
  }
  
  /**
   * Get orderbook (depth)
   */
  async getOrderbook(limit: number = 10): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
    const productId = await this.discoverFuturesProduct();
    const path = `/api/v3/brokerage/product_book?product_id=${productId}&limit=${limit}`;
    const data = await this.request("GET", path);
    
    const pricebook = data.pricebook || {};
    return {
      bids: (pricebook.bids || []).map((b: any) => [parseFloat(b.price), parseFloat(b.size)]),
      asks: (pricebook.asks || []).map((a: any) => [parseFloat(a.price), parseFloat(a.size)]),
    };
  }
  
  // ===== CFM (Coinbase Financial Markets) Futures-specific =====
  
  /**
   * Get futures balance summary
   */
  async getBalance(): Promise<CFMBalance> {
    const data = await this.request("GET", "/api/v3/brokerage/cfm/balance_summary");
    const summary = data.balance_summary || data;
    return summary;
  }
  
  /**
   * Get open futures positions
   */
  async getPositions(): Promise<CFMPosition[]> {
    const data = await this.request("GET", "/api/v3/brokerage/cfm/positions");
    return data.positions || [];
  }
  
  /**
   * Get specific position
   */
  async getPosition(productId?: string): Promise<CFMPosition | null> {
    const pid = productId || await this.discoverFuturesProduct();
    try {
      const data = await this.request("GET", `/api/v3/brokerage/cfm/positions/${pid}`);
      return data.position || null;
    } catch {
      return null; // No position
    }
  }
  
  /**
   * Get current intraday margin window status
   */
  async getMarginWindow(): Promise<any> {
    return this.request("GET", "/api/v3/brokerage/cfm/intraday/current_margin_window");
  }
  
  /**
   * Set intraday margin (enable higher leverage during market hours)
   */
  async setIntradayMargin(setting: "STANDARD" | "INTRADAY"): Promise<any> {
    return this.request("POST", "/api/v3/brokerage/cfm/intraday/margin_setting", {
      setting,
    });
  }
  
  /**
   * List all available products (for debugging)
   */
  async listProducts(type?: string): Promise<CoinbaseProduct[]> {
    const path = type 
      ? `/api/v3/brokerage/products?product_type=${type}`
      : "/api/v3/brokerage/products";
    const data = await this.request("GET", path);
    return data.products || [];
  }
  
  // ===== Helpers =====
  
  private getIntervalSeconds(interval: string): number {
    const map: Record<string, number> = {
      "1m": 60,
      "5m": 300,
      "15m": 900,
      "30m": 1800,
      "1h": 3600,
      "2h": 7200,
      "6h": 21600,
      "1d": 86400,
    };
    return map[interval] || 60;
  }
  
  /**
   * Get the active product ID (after discovery)
   */
  get productId(): string | null {
    return this.activeProductId;
  }
  
  /**
   * Override product ID manually (e.g., for specific contract month)
   */
  setProductId(productId: string): void {
    this.activeProductId = productId;
    log(`📊 Product override: ${productId}`);
  }
}

