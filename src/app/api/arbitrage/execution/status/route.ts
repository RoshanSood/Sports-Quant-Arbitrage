import { NextResponse } from "next/server";
import { verifyAllVenues } from "@/lib/arbitrage/execution/verify";
import { getExecutionMode, liveVenueAllowlist, maxLiveStakeUsd, onchainOrdersEnabled } from "@/lib/arbitrage/execution/config";

// Execution readiness per venue (manual §19, §24): masked wallet identity + USDC
// balance/allowance + verification status. Reads only — never places an order and
// never returns raw keys. The wallet address is masked before it leaves the server.
function maskAddress(a: string | null): string | null {
  if (!a || a.length < 10) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export async function GET() {
  try {
    const venues = await verifyAllVenues();
    return NextResponse.json({
      venues: venues.map((v) => ({ ...v, address: maskAddress(v.address) })),
      gate: {
        executionMode: getExecutionMode(),
        liveVenues: [...liveVenueAllowlist()],
        maxLiveStakeUsd: maxLiveStakeUsd(),
        onchainOrdersEnabled: onchainOrdersEnabled(),
      },
    });
  } catch (error) {
    return NextResponse.json({ venues: [], error: String(error) }, { status: 500 });
  }
}
