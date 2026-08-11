// Venue execution-adapter boundary. The executor speaks only this interface, so
// dry-run and each live venue share one code path. A leg's venue-native identifier
// (Kalshi ticker / Polymarket tokenId / SX marketHash) rides on the OrderRequest —
// live adapters refuse to place an order without it.

export type OrderFillStatus = "pending" | "filled" | "partial" | "unfilled" | "rejected";

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
  // Some venues acknowledge with a display/API id but require a hash for confirmation.
  confirmationId?: string | null;
  filledContracts: number;
  avgPriceCents: number;
  status: OrderFillStatus;
  error?: string;
  raw?: unknown;
};

// A fresh, venue-native executable quote taken immediately before placement. The
// executor uses the smallest availableContracts across every leg, then re-prices and
// re-checks the whole basket before sending any order.
export type ExecutableOrderQuote = {
  ok: boolean;
  priceCents: number; // worst price required to fill availableContracts
  averagePriceCents: number;
  availableContracts: number;
  // Fresh executable ask levels, cheapest first. Keeping the ladder lets the executor
  // optimize price and common contract count without making another network request for
  // every possible size. Venues that only expose top-of-book return one level.
  levels?: Array<{ priceCents: number; contracts: number }>;
  reason?: string;
};

// Post-placement settlement confirmation. On-chain venues (SX.bet especially) ack an
// order before it settles on-chain (PENDING → SUCCESS/FAILED), so the placement result
// is not final truth — reconciliation re-queries the venue to confirm.
export type FillConfirmation = {
  status: "settled" | "pending" | "failed" | "unknown";
  filledContracts?: number;
  avgPriceCents?: number;
  error?: string;
};

export interface ExecutionAdapter {
  id: string;
  // True only when real credentials / a wallet signer are configured for this venue.
  supportsLive(): boolean;
  // Account balance in USD, or null if unknown/unconfigured.
  getBalanceUsd(): Promise<number | null>;
  quoteOrder?(req: OrderRequest): Promise<ExecutableOrderQuote>;
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  // Optional: re-query the venue to confirm an order actually settled. Absent ⇒ the
  // placement result is treated as authoritative (currently Kalshi IOC).
  confirmFill?(orderId: string, req: OrderRequest): Promise<FillConfirmation>;
}
