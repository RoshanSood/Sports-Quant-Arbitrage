// One-time USDC allowance approval (manual §13, §19). Before an exchange can fill an
// order it must be approved to pull USDC from the venue wallet. This route signs the
// approve() tx SERVER-SIDE with the configured key (never in the browser) and is admin-
// guarded. It sets an allowance only — it never places a bet. Read the resulting
// allowance back via GET /api/arbitrage/execution/status.

import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/adminAuth";
import { getSxMetadata } from "@/lib/arbitrage/execution/sxMeta";
import { extractOnchainCredsFromHeaders } from "@/lib/arbitrage/execution/onchainCreds";
import { approveUsdc, hasWalletKey } from "@/lib/arbitrage/execution/wallet";

type Body = { venue?: "polymarket" | "sxbet"; password?: string; amountUsd?: number };

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
  // Polymarket US is a custodial central exchange — no on-chain USDC allowance to set
  // (funds already sit in the account). Only SX.bet (on-chain) needs an approval.
  if (venue === "polymarket") {
    return NextResponse.json({ error: "Polymarket US needs no USDC allowance (custodial). Fund the account directly." }, { status: 400 });
  }
  if (venue !== "sxbet") {
    return NextResponse.json({ error: "venue must be 'sxbet' (Polymarket US needs no approval)" }, { status: 400 });
  }
  // Wallet key from the UI (header) or server env.
  const onchain = extractOnchainCredsFromHeaders(req.headers);
  const keyOverride = onchain.sxbet?.key;
  if (!hasWalletKey(venue, keyOverride)) {
    return NextResponse.json({ error: `${venue} wallet key not provided (enter it in the venue Credentials tab or set it server-side)` }, { status: 400 });
  }

  try {
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
