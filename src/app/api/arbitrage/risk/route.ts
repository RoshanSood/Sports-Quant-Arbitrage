import { NextRequest, NextResponse } from "next/server";
import { getRiskSettings, updateRiskSettings } from "@/lib/arbitrage/riskStore";
import type { RiskSettings } from "@/types/arbitrage";

export async function GET() {
  try {
    const risk = await getRiskSettings();
    return NextResponse.json({ risk });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const partial = (await request.json()) as Partial<RiskSettings>;
    const risk = await updateRiskSettings(partial);
    return NextResponse.json({ ok: true, risk });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
