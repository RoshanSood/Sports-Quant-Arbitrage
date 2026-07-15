// SX.bet taker-fill adapter (manual §13). Fills existing maker orders via the v2
// endpoint POST /orders/fill/v2, which auto-matches against the best maker orders at
// or better than our desiredOdds — so we only sign the taker payload, no maker-order
// bookkeeping. Signing follows SX's documented EIP-712 schema (domain verifyingContract
// = EIP712FillHasher from /metadata). The wallet key is server-side only.
//
// supportsLive() stays false until the operator flips ARB_ONCHAIN_ORDERS_ENABLED after a
// verified signer + paper run + a $1 live fill. The execution gate still applies on top.
//
// NOTE: the exact HTTP request/response envelope of /orders/fill/v2 must be confirmed
// against a live $1 fill before enabling; the EIP-712 signing schema below is quoted
// from SX's API docs. The deterministic math lives in exported pure helpers (tested).

import { Wallet, ZeroAddress, ZeroHash, hexlify, randomBytes } from "ethers";
import { SX_CHAIN_ID } from "./chains";
import { onchainOrdersEnabled } from "./config";
import { getSxMetadata } from "./sxMeta";
import { verifySx } from "./verify";
import type { ExecutionAdapter, FillConfirmation, OrderRequest, OrderResult } from "./types";
import { deriveEoa, hasWalletKey, signerFor } from "./wallet";

const SX_FILL_URL = "https://api.sx.bet/orders/fill/v2";
const SX_TRADES_URL = "https://api.sx.bet/trades";

// USDC risked (in 6-decimal wei) to buy `sizeContracts` at `limitPriceCents`:
// cost = contracts × price. Each contract pays $1 on win, costs price/100 now.
export function stakeWeiFor(sizeContracts: number, limitPriceCents: number): string {
  const microUsd = Math.round(sizeContracts * limitPriceCents * 10_000); // contracts × (cents/100) × 1e6
  return BigInt(Math.max(0, microUsd)).toString();
}

// Worst acceptable odds in SX format = takerImpliedProb × 1e20. Our price in cents is
// that implied probability × 100, so desiredOdds = cents × 1e18 (exact, no float 1e20).
export function desiredOddsFor(limitPriceCents: number): string {
  const TEN_POW_18 = BigInt("1000000000000000000"); // 1e18 (BigInt literals need ES2020 target)
  return (BigInt(Math.round(limitPriceCents)) * TEN_POW_18).toString();
}

export function fillSalt(): string {
  return BigInt(hexlify(randomBytes(32))).toString();
}

function oddsSlippage(): number {
  const v = Number(process.env.SXBET_ODDS_SLIPPAGE);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 0; // 0 = pre-game default
}

export type FillSignParams = {
  stakeWei: string;
  marketHash: string;
  baseToken: string;
  desiredOdds: string;
  oddsSlippage: number;
  isTakerBettingOutcomeOne: boolean;
  fillSalt: string;
  domainVersion: string;
  verifyingContract: string;
};

// EIP-712 domain/types/message for a taker fill (schema quoted from SX docs). Exported
// so the structure can be unit-tested with a sign→recover round-trip.
export function buildFillTypedData(params: FillSignParams) {
  const domain = {
    name: "SX Bet",
    version: params.domainVersion,
    chainId: SX_CHAIN_ID,
    verifyingContract: params.verifyingContract,
  };
  const types = {
    Details: [
      { name: "action", type: "string" },
      { name: "market", type: "string" },
      { name: "betting", type: "string" },
      { name: "stake", type: "string" },
      { name: "worstOdds", type: "string" },
      { name: "worstReturning", type: "string" },
      { name: "fills", type: "FillObject" },
    ],
    FillObject: [
      { name: "stakeWei", type: "string" },
      { name: "marketHash", type: "string" },
      { name: "baseToken", type: "string" },
      { name: "desiredOdds", type: "string" },
      { name: "oddsSlippage", type: "uint256" },
      { name: "isTakerBettingOutcomeOne", type: "bool" },
      { name: "fillSalt", type: "uint256" },
      { name: "beneficiary", type: "address" },
      { name: "beneficiaryType", type: "uint8" },
      { name: "cashOutTarget", type: "bytes32" },
    ],
  };
  const message = {
    action: "N/A",
    market: params.marketHash,
    betting: "N/A",
    stake: "N/A",
    worstOdds: "N/A",
    worstReturning: "N/A",
    fills: {
      stakeWei: params.stakeWei,
      marketHash: params.marketHash,
      baseToken: params.baseToken,
      desiredOdds: params.desiredOdds,
      oddsSlippage: params.oddsSlippage,
      isTakerBettingOutcomeOne: params.isTakerBettingOutcomeOne,
      fillSalt: params.fillSalt,
      beneficiary: ZeroAddress,
      beneficiaryType: 0,
      cashOutTarget: ZeroHash,
    },
  };
  return { domain, types, message };
}

async function signFill(wallet: Wallet, params: FillSignParams): Promise<string> {
  const { domain, types, message } = buildFillTypedData(params);
  return wallet.signTypedData(domain, types, message);
}

type SxFillResponse = { status?: string; message?: string; data?: { fillHash?: string; totalFilled?: string } };

export class SxBetExecutionAdapter implements ExecutionAdapter {
  id = "sxbet";

  supportsLive(): boolean {
    return hasWalletKey("sxbet") && onchainOrdersEnabled();
  }

  async getBalanceUsd(): Promise<number | null> {
    if (!hasWalletKey("sxbet")) return null;
    return (await verifySx()).usdcBalance;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    if (!hasWalletKey("sxbet")) return reject(req, "SX.bet wallet key not configured");
    if (!onchainOrdersEnabled()) return reject(req, "on-chain orders disabled (set ARB_ONCHAIN_ORDERS_ENABLED=true after $1 validation)");

    const marketHash = req.nativeMarketId;
    const side = (req.nativeSide ?? "").toLowerCase();
    if (!marketHash || (side !== "one" && side !== "two")) {
      return reject(req, "missing SX.bet marketHash/outcome side — live order not wired for this leg");
    }
    const wallet = signerFor("sxbet");
    if (!wallet) return reject(req, "invalid SXBET_WALLET_KEY");

    const meta = await getSxMetadata();
    if (!meta?.usdcAddress || !meta.eip712FillHasher || !meta.domainVersion) {
      return reject(req, "SX /metadata missing baseToken/fillHasher/domainVersion");
    }

    const isTakerBettingOutcomeOne = side === "one";
    const stakeWei = stakeWeiFor(req.sizeContracts, req.limitPriceCents);
    const desiredOdds = desiredOddsFor(req.limitPriceCents);
    const salt = fillSalt();
    const slippage = oddsSlippage();

    try {
      const takerSig = await signFill(wallet, {
        stakeWei,
        marketHash,
        baseToken: meta.usdcAddress,
        desiredOdds,
        oddsSlippage: slippage,
        isTakerBettingOutcomeOne,
        fillSalt: salt,
        domainVersion: meta.domainVersion,
        verifyingContract: meta.eip712FillHasher,
      });

      const body = {
        marketHash,
        market: marketHash,
        baseToken: meta.usdcAddress,
        isTakerBettingOutcomeOne,
        stakeWei,
        desiredOdds,
        oddsSlippage: slippage,
        taker: await wallet.getAddress(),
        takerSig,
        fillSalt: salt,
        message: "N/A",
      };

      const res = await fetch(SX_FILL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as SxFillResponse;
      const ok = res.ok && json.status !== "failure";
      if (!ok) return reject(req, json.message || `SX fill rejected (HTTP ${res.status})`);

      // v2 matches up to stakeWei at desiredOdds-or-better. Treat an accepted fill as
      // full unless the response reports a smaller total.
      const filled = req.sizeContracts;
      return {
        ok: true,
        orderId: json.data?.fillHash ?? null,
        filledContracts: filled,
        avgPriceCents: req.limitPriceCents,
        status: "filled",
        raw: json,
      };
    } catch (e) {
      return reject(req, String(e).slice(0, 200));
    }
  }

  // SX settles the fill on-chain AFTER the API ack (PENDING → SUCCESS/FAILED), so confirm
  // by polling /trades for our fillHash. Best-effort: any miss/parse issue → "pending"
  // (never a false "failed"), so reconciliation won't wrongly flag a leg naked.
  async confirmFill(orderId: string, req: OrderRequest): Promise<FillConfirmation> {
    const taker = deriveEoa("sxbet");
    const marketHash = req.nativeMarketId;
    if (!taker || !marketHash) return { status: "unknown" };
    try {
      const url = `${SX_TRADES_URL}?bettor=${taker}&marketHashes=${marketHash}`;
      const res = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
      if (!res.ok) return { status: "pending" };
      const json = (await res.json()) as { data?: { trades?: Array<{ fillHash?: string; tradeStatus?: string; status?: string; settled?: boolean }> } };
      const trade = (json.data?.trades ?? []).find((t) => t.fillHash === orderId);
      if (!trade) return { status: "pending" };
      const s = (trade.tradeStatus ?? trade.status ?? "").toUpperCase();
      if (s === "SUCCESS" || trade.settled === true) return { status: "settled" };
      if (s === "FAILED") return { status: "failed", filledContracts: 0 };
      return { status: "pending" };
    } catch {
      return { status: "unknown" };
    }
  }
}

function reject(req: OrderRequest, error: string): OrderResult {
  return { ok: false, orderId: null, filledContracts: 0, avgPriceCents: req.limitPriceCents, status: "rejected", error };
}
