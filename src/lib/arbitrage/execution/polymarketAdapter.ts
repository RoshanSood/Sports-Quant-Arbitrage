// Polymarket CLOB live order adapter (manual §12, §14). Signs and posts orders with
// the OFFICIAL @polymarket/clob-client. Each arb leg is a marketable **FOK** limit BUY
// at our max price: it either fills entirely and immediately at ≤ our price, or is
// killed — so we never leave a resting (naked) order, matching the arb "both legs or
// nothing" requirement. The wallet key is read server-side only and never leaves the
// process. A venue is live-capable once its wallet key is present; whether a live order
// actually fires is decided by the execution gate (agent Live toggle + kill switch +
// UI stake cap + admin auth) — validate with a $1 trade before raising the cap.

import { ClobClient, type ApiKeyCreds, Chain, OrderType, Side, SignatureType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { POLYGON_CHAIN_ID, polymarketClobHost } from "./chains";
import type { PolymarketCreds } from "./onchainCreds";
import { verifyPolymarket } from "./verify";
import type { ExecutionAdapter, OrderRequest, OrderResult } from "./types";
import { clobSignerShim, walletKey } from "./wallet";

// Which signature scheme the funded wallet uses. Default EOA (direct wallet). Users
// whose USDC lives in a Polymarket proxy/safe pass funder + sigType (UI or env).
function signatureType(sig?: number): SignatureType {
  const v = sig ?? Number(process.env.POLYMARKET_SIG_TYPE);
  if (v === 1) return SignatureType.POLY_PROXY;
  if (v === 2) return SignatureType.POLY_GNOSIS_SAFE;
  return SignatureType.EOA;
}

// Cache authenticated (L2) clients per wallet key — deriving API creds signs + hits the
// network, so we do it once per key (UI-entered or env). Keyed by the raw key string.
const clientCache = new Map<string, ClobClient>();

async function buildClient(key: string, funderOverride?: string, sigType?: number): Promise<ClobClient> {
  const cached = clientCache.get(key);
  if (cached) return cached;

  const wallet = new Wallet(key);
  const signer = clobSignerShim(wallet);
  const host = polymarketClobHost();
  const chainId = POLYGON_CHAIN_ID as Chain;
  const st = signatureType(sigType);
  const funder = funderOverride?.trim() || process.env.POLYMARKET_FUNDER?.trim() || (await wallet.getAddress());

  // L1: sign to create-or-derive the L2 API credentials, then build the L2 client.
  const l1 = new ClobClient(host, chainId, signer, undefined, st, funder);
  const creds: ApiKeyCreds = await l1.createOrDeriveApiKey();
  const client = new ClobClient(host, chainId, signer, creds, st, funder);

  clientCache.set(key, client);
  return client;
}

type PostOrderResponse = {
  success?: boolean;
  errorMsg?: string;
  orderID?: string;
  status?: string;
  takingAmount?: string; // shares received (BUY)
  makingAmount?: string; // USDC paid (BUY)
};

// avg fill price in cents from the response amounts (USDC paid / shares received),
// falling back to our limit when the amounts are absent.
function avgCentsFrom(resp: PostOrderResponse, limitCents: number): number {
  const paid = Number(resp.makingAmount);
  const shares = Number(resp.takingAmount);
  if (Number.isFinite(paid) && Number.isFinite(shares) && shares > 0) {
    return Math.round((paid / shares) * 100);
  }
  return limitCents;
}

export class PolymarketExecutionAdapter implements ExecutionAdapter {
  id = "polymarket";
  constructor(private creds?: PolymarketCreds) {}

  private key(): string | undefined {
    return walletKey("polymarket", this.creds?.key);
  }

  supportsLive(): boolean {
    // Live-capable once a wallet key is present (entered in the UI or env). The gate
    // (agent live toggle + kill switch + stake cap + admin auth) decides if it fires.
    return Boolean(this.key());
  }

  async getBalanceUsd(): Promise<number | null> {
    if (!this.key()) return null;
    return (await verifyPolymarket(this.creds)).usdcBalance;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const key = this.key();
    if (!key) return reject(req, "Polymarket wallet key not configured");

    // For Polymarket we thread the ERC-1155 CLOB token id as the leg's nativeSide.
    const tokenID = req.nativeSide;
    if (!tokenID) return reject(req, "missing Polymarket token id — live order not wired for this leg");

    const price = req.limitPriceCents / 100; // probability price 0..1
    try {
      const client = await buildClient(key, this.creds?.funder, this.creds?.sigType);
      // createOrder auto-resolves tickSize + negRisk for the token and rounds price.
      const signed = await client.createOrder({ tokenID, price, size: req.sizeContracts, side: Side.BUY });
      const resp = (await client.postOrder(signed, OrderType.FOK)) as PostOrderResponse;

      const ok = resp.success === true && Boolean(resp.orderID);
      // FOK is all-or-nothing: success ⇒ fully filled, else nothing filled.
      const filled = ok ? req.sizeContracts : 0;
      return {
        ok,
        orderId: resp.orderID ?? null,
        filledContracts: filled,
        avgPriceCents: avgCentsFrom(resp, req.limitPriceCents),
        status: ok ? "filled" : "unfilled",
        error: ok ? undefined : resp.errorMsg || `order not filled (${resp.status ?? "unknown"})`,
        raw: resp,
      };
    } catch (e) {
      return reject(req, String(e).slice(0, 200));
    }
  }
}

function reject(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}
