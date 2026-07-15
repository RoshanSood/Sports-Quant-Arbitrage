import { NextRequest, NextResponse } from "next/server";
import { getRiskSettings, updateRiskSettings } from "@/lib/arbitrage/riskStore";
import type { RiskSettings } from "@/types/arbitrage";
import { isAuthorized } from "@/lib/adminAuth";
import { validateRiskPatch } from "@/lib/arbitrage/validation";

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
    const body = (await request.json()) as Partial<RiskSettings> & { password?: string };
    if (!isAuthorized(request, body.password)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { password: _password, ...candidate } = body;
    void _password;
    const partial = validateRiskPatch(candidate);
    const risk = await updateRiskSettings(partial);
    return NextResponse.json({ ok: true, risk });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}
