// One-time USDC allowance approval (manual §13, §19). Before an exchange can fill an
// order it must be approved to pull USDC from the venue wallet. This route signs the
// approve() tx SERVER-SIDE with the configured key (never in the browser) and is admin-
// guarded. It sets an allowance only — it never places a bet. Read the resulting
// allowance back via GET /api/arbitrage/execution/status.

import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/adminAuth";
import {
  POLYMARKET_CTF_EXCHANGE,
  POLYMARKET_NEG_RISK_EXCHANGE,
  polygonUsdcAddress,
} from "@/lib/arbitrage/execution/chains";
import { getSxMetadata } from "@/lib/arbitrage/execution/sxMeta";
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
  if (venue !== "polymarket" && venue !== "sxbet") {
    return NextResponse.json({ error: "venue must be 'polymarket' or 'sxbet'" }, { status: 400 });
  }
  if (!hasWalletKey(venue)) {
    return NextResponse.json({ error: `${venue} wallet key not configured server-side` }, { status: 400 });
  }

  try {
    if (venue === "polymarket") {
      const usdc = polygonUsdcAddress();
      // Approve both exchanges (regular + neg-risk) so either market type can fill.
      const ctf = await approveUsdc("polymarket", usdc, POLYMARKET_CTF_EXCHANGE, body.amountUsd);
      const negRisk = await approveUsdc("polymarket", usdc, POLYMARKET_NEG_RISK_EXCHANGE, body.amountUsd);
      return NextResponse.json({ venue, spenders: { ctfExchange: ctf, negRiskExchange: negRisk } });
    }
    // sxbet: approve the TokenTransferProxy from live metadata.
    const meta = await getSxMetadata();
    const spender = meta?.tokenTransferProxy ?? meta?.executorAddress;
    if (!meta?.usdcAddress || !spender) {
      return NextResponse.json({ error: "SX /metadata missing USDC address or transfer proxy" }, { status: 502 });
    }
    const result = await approveUsdc("sxbet", meta.usdcAddress, spender, body.amountUsd);
    return NextResponse.json({ venue, spender, result });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
