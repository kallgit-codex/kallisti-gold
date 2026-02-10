// Coinbase Advanced Trade - Order Execution
// Handles: market orders, limit orders, cancel, order status
// For CFM futures (BIP contracts)
//
// Contract specs:
//   - 1 contract = 1 oz gold (or 0.01 BTC)
//   - Cash-settled, USD margin
//   - Max 10x intraday leverage (8 AM - 4 PM ET)
//   - Fees: 0% maker / 0.03% taker (promotional)

import { CoinbaseAuthConfig, getAuthHeader } from "./coinbase-auth";
import { log, error } from "../logger";

export interface OrderRequest {
  side: "BUY" | "SELL";
  productId: string;
  size: string;           // Number of contracts (each = 0.01 BTC)
  type: "market" | "limit";
  limitPrice?: string;    // For limit orders
  postOnly?: boolean;     // For maker-only orders (0% fee)
  leverage?: string;      // Leverage level
}

export interface OrderResponse {
  order_id: string;
  product_id: string;
  side: string;
  status: string;
  filled_size: string;
  average_filled_price: string;
  fee: string;
  created_time: string;
  completion_percentage: string;
}

export interface OrderPreview {
  order_total: string;
  commission_total: string;
  slippage: string;
  best_bid: string;
  best_ask: string;
  leverage: string;
  long_leverage: string;
  short_leverage: string;
}

export class CoinbaseTrader {
  private baseUrl: string;
  private auth: CoinbaseAuthConfig;
  
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
      throw new Error(`Coinbase ${method} ${path} → ${response.status}: ${errText}`);
    }
    
    return response.json();
  }
  
  /**
   * Calculate number of contracts for a given USD position size
   * 1 contract = 0.01 BTC
   * At $5000 gold: 1 contract = $5,000
   */
  static calculateContracts(positionSizeUsd: number, assetPrice: number): number {
    // Gold: 1 contract = 1 oz gold ≈ $5,000
    // BTC: 1 contract = 0.01 BTC
    const contractSize = assetPrice > 10000 ? 0.01 : 1; // Auto-detect: if price > $10k it's BTC
    const contractValueUsd = contractSize * assetPrice;
    return Math.max(1, Math.floor(positionSizeUsd / contractValueUsd));
  }
  
  /**
   * Preview an order before execution (no risk, returns expected fees/slippage)
   */
  async previewOrder(order: OrderRequest): Promise<OrderPreview> {
    const clientOrderId = `preview-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    
    const orderConfig: any = order.type === "market"
      ? { market_market_ioc: { quote_size: order.size } }
      : { 
          limit_limit_gtc: { 
            base_size: order.size,
            limit_price: order.limitPrice,
            post_only: order.postOnly || false,
          }
        };
    
    const body = {
      product_id: order.productId,
      side: order.side,
      order_configuration: orderConfig,
      leverage: order.leverage,
    };
    
    const data = await this.request("POST", "/api/v3/brokerage/orders/preview", body);
    return data;
  }
  
  /**
   * Place a market order
   */
  async marketOrder(
    side: "BUY" | "SELL",
    productId: string,
    contracts: number,
    leverage?: string
  ): Promise<OrderResponse> {
    const clientOrderId = `ks-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    
    const body: any = {
      client_order_id: clientOrderId,
      product_id: productId,
      side,
      order_configuration: {
        market_market_ioc: {
          base_size: String(contracts),
        },
      },
    };
    
    if (leverage) {
      body.leverage = leverage;
    }
    
    log(`📤 ${side} ${contracts} contracts of ${productId} (market)`);
    
    const data = await this.request("POST", "/api/v3/brokerage/orders", body);
    
    if (data.success === false) {
      throw new Error(`Order rejected: ${data.error_response?.error || data.error_response?.message || JSON.stringify(data)}`);
    }
    
    const orderId = data.success_response?.order_id || data.order_id;
    log(`✅ Order placed: ${orderId}`);
    
    // Fetch full order details
    return this.getOrder(orderId);
  }
  
  /**
   * Place a limit order (post-only for 0% maker fee)
   */
  async limitOrder(
    side: "BUY" | "SELL",
    productId: string,
    contracts: number,
    price: string,
    postOnly: boolean = true,
    leverage?: string
  ): Promise<OrderResponse> {
    const clientOrderId = `ks-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    
    const body: any = {
      client_order_id: clientOrderId,
      product_id: productId,
      side,
      order_configuration: {
        limit_limit_gtc: {
          base_size: String(contracts),
          limit_price: price,
          post_only: postOnly,
        },
      },
    };
    
    if (leverage) {
      body.leverage = leverage;
    }
    
    log(`📤 ${side} ${contracts} @ $${price} ${productId} (limit${postOnly ? " post-only" : ""})`);
    
    const data = await this.request("POST", "/api/v3/brokerage/orders", body);
    
    if (data.success === false) {
      throw new Error(`Order rejected: ${data.error_response?.error || data.error_response?.message || JSON.stringify(data)}`);
    }
    
    const orderId = data.success_response?.order_id || data.order_id;
    log(`✅ Order placed: ${orderId}`);
    return this.getOrder(orderId);
  }
  
  /**
   * Cancel one or more orders
   */
  async cancelOrders(orderIds: string[]): Promise<any> {
    log(`🚫 Cancelling ${orderIds.length} order(s)`);
    return this.request("POST", "/api/v3/brokerage/orders/batch_cancel", {
      order_ids: orderIds,
    });
  }
  
  /**
   * Cancel all open orders for a product
   */
  async cancelAllOrders(productId: string): Promise<any> {
    // First get all open orders
    const orders = await this.listOrders(productId, "OPEN");
    if (orders.length === 0) return { cancelled: 0 };
    
    const orderIds = orders.map((o: any) => o.order_id);
    return this.cancelOrders(orderIds);
  }
  
  /**
   * Get order by ID
   */
  async getOrder(orderId: string): Promise<OrderResponse> {
    const data = await this.request("GET", `/api/v3/brokerage/orders/historical/${orderId}`);
    return data.order || data;
  }
  
  /**
   * List orders for a product
   */
  async listOrders(productId?: string, status?: string): Promise<any[]> {
    let path = "/api/v3/brokerage/orders/historical/batch?";
    if (productId) path += `product_id=${productId}&`;
    if (status) path += `order_status=${status}&`;
    path += "limit=50";
    
    const data = await this.request("GET", path);
    return data.orders || [];
  }
  
  /**
   * Get fills (executed trades)
   */
  async listFills(productId?: string, limit: number = 50): Promise<any[]> {
    let path = `/api/v3/brokerage/orders/historical/fills?limit=${limit}`;
    if (productId) path += `&product_id=${productId}`;
    
    const data = await this.request("GET", path);
    return data.fills || [];
  }
  
  /**
   * Close a position (market order in opposite direction)
   */
  async closePosition(
    productId: string,
    currentSide: "Long" | "Short",
    contracts: number
  ): Promise<OrderResponse> {
    const closeSide = currentSide === "Long" ? "SELL" : "BUY";
    log(`🔄 Closing ${currentSide} position: ${closeSide} ${contracts} contracts`);
    return this.marketOrder(closeSide, productId, contracts);
  }
}

