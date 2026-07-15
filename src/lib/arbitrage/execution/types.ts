// Venue execution-adapter boundary. The executor speaks only this interface, so
// dry-run and each live venue share one code path. A leg's venue-native identifier
// (Kalshi ticker / Polymarket tokenId / SX marketHash) rides on the OrderRequest —
// live adapters refuse to place an order without it.

export type OrderFillStatus = "filled" | "partial" | "unfilled" | "rejected";

export type OrderRequest = {
  venueId: string;
  // Our synthetic id (for logging) + the venue-native id/side actually used to order.
  marketId: string;
  nativeMarketId?: string;
  nativeSide?: string;
  outcome: string; // over/under/home/away (our canonical)
  sizeContracts: number;
  limitPriceCents: number; // buy no higher than this
};

export type OrderResult = {
  ok: boolean;
  orderId: string | null;
  filledContracts: number;
  avgPriceCents: number;
  status: OrderFillStatus;
  error?: string;
  raw?: unknown;
};

export interface ExecutionAdapter {
  id: string;
  // True only when real credentials / a wallet signer are configured for this venue.
  supportsLive(): boolean;
  // Live arbitrage only uses all-or-nothing venue orders.
  supportsFillOrKill(): boolean;
  // Account balance in USD, or null if unknown/unconfigured.
  getBalanceUsd(): Promise<number | null>;
  placeOrder(req: OrderRequest): Promise<OrderResult>;
}
