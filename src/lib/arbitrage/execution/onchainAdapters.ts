// On-chain venue execution adapters (Polymarket, SX.bet). Balance reads are LIVE once
// a server-side wallet key is set, but supportsLive() stays FALSE until order signing
// is implemented + validated (manual §2 — no live orders before signer/paper/recon).
// Order placement lands in the order phase; until then placeOrder refuses.

import type { ExecutionAdapter, OrderRequest, OrderResult } from "./types";
import { hasWalletKey, type OnchainVenue } from "./wallet";
import { verifyPolymarket, verifySx } from "./verify";

class OnchainAdapter implements ExecutionAdapter {
  constructor(public id: OnchainVenue) {}

  supportsLive(): boolean {
    // A funded, verified wallet is not enough — order signing isn't wired yet, so the
    // gate must keep this venue out of live execution. Flip to (hasWalletKey && ...)
    // only once placeOrder is implemented and testnet/$1-validated.
    return false;
  }

  async getBalanceUsd(): Promise<number | null> {
    if (!hasWalletKey(this.id)) return null;
    const v = this.id === "polymarket" ? await verifyPolymarket() : await verifySx();
    return v.usdcBalance;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    return {
      ok: false,
      orderId: null,
      filledContracts: 0,
      avgPriceCents: req.limitPriceCents,
      status: "rejected",
      error: `${this.id} order placement not yet enabled (verification phase — see manual §2)`,
    };
  }
}

export class PolymarketExecutionAdapter extends OnchainAdapter {
  constructor() {
    super("polymarket");
  }
}

export class SxBetExecutionAdapter extends OnchainAdapter {
  constructor() {
    super("sxbet");
  }
}
