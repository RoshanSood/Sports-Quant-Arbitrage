// Polymarket CLOB live order adapter (manual §12, §14). Signs and posts orders with
// the OFFICIAL @polymarket/clob-client. Each arb leg is a marketable **FOK** limit BUY
// at our max price: it either fills entirely and immediately at ≤ our price, or is
// killed — so we never leave a resting (naked) order, matching the arb "both legs or
// nothing" requirement. The wallet key is read server-side only and never leaves the
// process. supportsLive() stays false until the operator flips ARB_ONCHAIN_ORDERS_ENABLED
// after a verified signer + paper run + $1 live fill. The gate still applies on top.

import { ClobClient, type ApiKeyCreds, Chain, OrderType, Side, SignatureType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { POLYGON_CHAIN_ID, polymarketClobHost } from "./chains";
import { onchainOrdersEnabled } from "./config";
import { verifyPolymarket } from "./verify";
import type { ExecutionAdapter, OrderRequest, OrderResult } from "./types";
import { clobSignerShim, hasWalletKey, walletKey } from "./wallet";

// Which signature scheme the funded wallet uses. Default EOA (direct wallet). Users
// whose USDC lives in a Polymarket proxy/safe set POLYMARKET_FUNDER + POLYMARKET_SIG_TYPE.
function signatureType(): SignatureType {
  const v = Number(process.env.POLYMARKET_SIG_TYPE);
  if (v === 1) return SignatureType.POLY_PROXY;
  if (v === 2) return SignatureType.POLY_GNOSIS_SAFE;
  return SignatureType.EOA;
}

// Cache the authenticated (L2) client per process — deriving API creds signs + hits
// the network, so we do it once.
let cachedClient: ClobClient | null = null;
let cachedForKey: string | null = null;

async function getClient(): Promise<ClobClient> {
  const key = walletKey("polymarket");
  if (!key) throw new Error("POLYMARKET_WALLET_KEY not set");
  if (cachedClient && cachedForKey === key) return cachedClient;

  const wallet = new Wallet(key);
  const signer = clobSignerShim(wallet);
  const host = polymarketClobHost();
  const chainId = POLYGON_CHAIN_ID as Chain;
  const sigType = signatureType();
  const funder = process.env.POLYMARKET_FUNDER?.trim() || (await wallet.getAddress());

  // L1: sign to create-or-derive the L2 API credentials, then build the L2 client.
  const l1 = new ClobClient(host, chainId, signer, undefined, sigType, funder);
  const creds: ApiKeyCreds = await l1.createOrDeriveApiKey();
  const client = new ClobClient(host, chainId, signer, creds, sigType, funder);

  cachedClient = client;
  cachedForKey = key;
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

  supportsLive(): boolean {
    return hasWalletKey("polymarket") && onchainOrdersEnabled();
  }

  async getBalanceUsd(): Promise<number | null> {
    if (!hasWalletKey("polymarket")) return null;
    return (await verifyPolymarket()).usdcBalance;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    if (!hasWalletKey("polymarket")) return reject(req, "Polymarket wallet key not configured");
    if (!onchainOrdersEnabled()) return reject(req, "on-chain orders disabled (set ARB_ONCHAIN_ORDERS_ENABLED=true after $1 validation)");

    // For Polymarket we thread the ERC-1155 CLOB token id as the leg's nativeSide.
    const tokenID = req.nativeSide;
    if (!tokenID) return reject(req, "missing Polymarket token id — live order not wired for this leg");

    const price = req.limitPriceCents / 100; // probability price 0..1
    try {
      const client = await getClient();
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
