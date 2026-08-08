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

export type ExecutableOrderQuote = {
  ok: boolean;
  priceCents: number;
  averagePriceCents: number;
  availableContracts: number;
  reason?: string;
};

// Post-placement settlement confirmation. On-chain venues (SX.bet especially) ack an
// order before it settles on-chain (PENDING → SUCCESS/FAILED), so the placement result
// is not final truth — reconciliation re-queries the venue to confirm.
export type FillConfirmation = {
  status: "settled" | "pending" | "failed" | "unknown";
  filledContracts?: number;
};

export interface ExecutionAdapter {
  id: string;
  // True only when real credentials / a wallet signer are configured for this venue.
  supportsLive(): boolean;
  // Account balance in USD, or null if unknown/unconfigured.
  getBalanceUsd(): Promise<number | null>;
  // Read the executable live book immediately before placement. The executor requests
  // every leg concurrently, then shrinks the basket to one common fillable size.
  quoteOrder?(req: OrderRequest): Promise<ExecutableOrderQuote>;
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  // Optional: re-query the venue to confirm an order actually settled. Absent ⇒ the
  // placement result is treated as authoritative (e.g. Kalshi IOC, Polymarket FOK).
  confirmFill?(orderId: string, req: OrderRequest): Promise<FillConfirmation>;
}
