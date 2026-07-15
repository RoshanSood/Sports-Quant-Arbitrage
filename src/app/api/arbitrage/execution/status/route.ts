import { NextResponse } from "next/server";
import { verifyAllVenues } from "@/lib/arbitrage/execution/verify";
import { extractOnchainCredsFromHeaders } from "@/lib/arbitrage/execution/onchainCreds";
import { extractCredsFromHeaders } from "@/lib/kalshiAuth";
import { getAgent } from "@/lib/arbitrage/agentStore";
import { getRiskSettings } from "@/lib/arbitrage/riskStore";
import { DEFAULT_AGENT } from "@/lib/arbitrage/seed";

// Execution readiness per venue: masked wallet identity + USDC balance/allowance +
// verification status, plus the UI-driven gate state (live arming is the agent's
// Paper/Live toggle + the risk kill switch + the risk stake cap — no env vars). Reads
// only — never places an order and never returns raw keys.
function maskAddress(a: string | null): string | null {
  if (!a || a.length < 10) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export async function GET(request: Request) {
  try {
    // Reflect UI-entered creds (forwarded as headers) as well as server-env creds.
    const kalshiCreds = extractCredsFromHeaders(request.headers);
    const onchain = extractOnchainCredsFromHeaders(request.headers);
    const [venues, agent, risk] = await Promise.all([
      verifyAllVenues({ kalshiCreds, ...onchain }),
      getAgent(DEFAULT_AGENT.id).then((a) => a ?? DEFAULT_AGENT),
      getRiskSettings(),
    ]);
    return NextResponse.json({
      venues: venues.map((v) => ({ ...v, address: maskAddress(v.address) })),
      gate: {
        // "Armed" for live orders = the agent's Live switch is on and not kill-switched.
        agentLive: agent.live && !agent.paper,
        killSwitch: risk.killSwitch,
        maxLiveStakeUsd: risk.maxLiveStakeUsd,
      },
    });
  } catch (error) {
    return NextResponse.json({ venues: [], error: String(error) }, { status: 500 });
  }
}
