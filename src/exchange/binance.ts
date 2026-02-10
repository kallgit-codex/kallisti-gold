export interface BinanceKlinesResponse extends Array<number | string> {}

export class BinanceClient {
  constructor(private baseUrl: string = "https://api.binance.com") {}

  async getKlines(symbol: string, interval: string, limit = 50) {
    const url = new URL("/api/v3/klines", this.baseUrl);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(limit));

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Binance HTTP ${response.status}: ${await response.text()}`);
    }

    const result: BinanceKlinesResponse[] = await response.json();
    return { list: result };
  }
}
