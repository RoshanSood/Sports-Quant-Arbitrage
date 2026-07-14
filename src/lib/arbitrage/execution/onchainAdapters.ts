// On-chain venue execution adapters (Polymarket CLOB, SX.bet) — SCAFFOLDS.
//
// These venues settle on a blockchain: placing an order means EIP-712-signing it with
// a funded wallet's private key (USDC on Polygon for Polymarket, SX Network for
// SX.bet) via each venue's SDK. That signer is intentionally NOT wired here — it
// requires the user's wallet key + the venue SDK + a funded on-chain balance, set up
// deliberately. Until a signer is configured, supportsLive() is false and placeOrder
// refuses, so the gate keeps these in dry-run.
//
// To go live on one of these: add a server-side wallet signer (key from a secret
// store, never the browser), install the venue SDK, thread the native tokenId /
// marketHash onto the leg, and implement placeOrder against the SDK.

import type { ExecutionAdapter, OrderRequest, OrderResult } from "./types";

class OnchainScaffold implements ExecutionAdapter {
  constructor(
    public id: string,
    private signerEnvVar: string
  ) {}

  supportsLive(): boolean {
    // A live signer would be detected here (e.g. a configured wallet key). None yet.
    return Boolean(process.env[this.signerEnvVar]) && false; // hard-disabled until implemented
  }

  async getBalanceUsd(): Promise<number | null> {
    return null;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    return {
      ok: false,
      orderId: null,
      filledContracts: 0,
      avgPriceCents: req.limitPriceCents,
      status: "rejected",
      error: `${this.id} live execution not implemented — on-chain wallet signer required`,
    };
  }
}

export class PolymarketExecutionAdapter extends OnchainScaffold {
  constructor() {
    super("polymarket", "POLYMARKET_WALLET_KEY");
  }
}

export class SxBetExecutionAdapter extends OnchainScaffold {
  constructor() {
    super("sxbet", "SXBET_WALLET_KEY");
  }
}
