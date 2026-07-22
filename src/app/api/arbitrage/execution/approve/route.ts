// One-time USDC allowance approval (manual §13, §19). Before an exchange can fill an
// order it must be approved to pull USDC from the venue wallet. This route signs the
// approve() tx SERVER-SIDE with the configured key (never in the browser) and is admin-
// guarded. It sets an allowance only — it never places a bet. Read the resulting
// allowance back via GET /api/arbitrage/execution/status.

import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/adminAuth";
import { polymarketRegion } from "@/lib/polymarketRegion";
import {
  POLYMARKET_CTF_EXCHANGE,
  POLYMARKET_NEG_RISK_EXCHANGE,
  polygonUsdcAddress,
} from "@/lib/arbitrage/execution/chains";
import { getSxMetadata } from "@/lib/arbitrage/execution/sxMeta";
import { extractOnchainCredsFromHeaders } from "@/lib/arbitrage/execution/onchainCreds";
import { approveUsdc, hasWalletKey } from "@/lib/arbitrage/execution/wallet";
import { POLYMARKET_DEPOSIT_WALLET_SIG_TYPE, updatePolymarketBalanceAllowance } from "@/lib/arbitrage/execution/polymarketAdapter";
import { pfSetApprovals, pfWalletKey } from "@/lib/arbitrage/execution/predictFunAdapter";

type Body = { venue?: "polymarket" | "sxbet" | "predictfun"; password?: string; amountUsd?: number };

export async function POST(req: Request) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // empty body
  }
  if (!isAuthorized(req, body.password)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const venue = body.venue;

  // predict.fun: run the SDK's one-shot setApprovals (ERC-1155 CTF + ERC-20 USDT). Needs
  // the wallet key + a little BNB gas (unless the smart account sponsors it).
  if (venue === "predictfun") {
    const creds = extractOnchainCredsFromHeaders(req.headers).predictfun;
    if (!pfWalletKey(creds)) {
      return NextResponse.json({ error: "predict.fun wallet key not provided (enter it in the venue Credentials tab)" }, { status: 400 });
    }
    const result = await pfSetApprovals(creds ?? {});
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "setApprovals failed", result }, { status: 500 });
    }
    return NextResponse.json({ venue, result });
  }

  if (venue !== "polymarket" && venue !== "sxbet") {
    return NextResponse.json({ error: "venue must be 'polymarket', 'sxbet', or 'predictfun'" }, { status: 400 });
  }
  // Polymarket US is custodial — no on-chain allowance to set (funds sit in the account).
  if (venue === "polymarket" && polymarketRegion() === "us") {
    return NextResponse.json({ error: "Polymarket US needs no USDC allowance (custodial). Fund the account directly." }, { status: 400 });
  }

  const onchain = extractOnchainCredsFromHeaders(req.headers);
  const keyOverride = venue === "polymarket" ? onchain.polymarket?.key : onchain.sxbet?.key;
  if (!hasWalletKey(venue, keyOverride)) {
    return NextResponse.json({ error: `${venue} wallet key not provided (enter it in the venue Credentials tab or set it server-side)` }, { status: 400 });
  }

  try {
    if (venue === "polymarket") {
      if (onchain.polymarket?.sigType === POLYMARKET_DEPOSIT_WALLET_SIG_TYPE) {
        await updatePolymarketBalanceAllowance(keyOverride!, onchain.polymarket.funder, onchain.polymarket.sigType);
        return NextResponse.json({ venue, updated: "polymarket-balance-allowance" });
      }
      // intl: approve both exchanges (regular + neg-risk) so either market type can fill.
      const usdc = polygonUsdcAddress();
      const ctf = await approveUsdc("polymarket", usdc, POLYMARKET_CTF_EXCHANGE, body.amountUsd, keyOverride);
      const negRisk = await approveUsdc("polymarket", usdc, POLYMARKET_NEG_RISK_EXCHANGE, body.amountUsd, keyOverride);
      return NextResponse.json({ venue, spenders: { ctfExchange: ctf, negRiskExchange: negRisk } });
    }
    // sxbet: approve the TokenTransferProxy from live metadata.
    const meta = await getSxMetadata();
    const spender = meta?.tokenTransferProxy ?? meta?.executorAddress;
    if (!meta?.usdcAddress || !spender) {
      return NextResponse.json({ error: "SX /metadata missing USDC address or transfer proxy" }, { status: 502 });
    }
    const result = await approveUsdc("sxbet", meta.usdcAddress, spender, body.amountUsd, keyOverride);
    return NextResponse.json({ venue, spender, result });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
