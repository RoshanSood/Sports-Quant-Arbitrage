import { NextRequest, NextResponse } from "next/server";
import { settleFinalPositions } from "@/lib/arbitrage/settlement";
import { isAuthorized } from "@/lib/adminAuth";

// Settle open paper positions whose games are final. Idempotent and admin-protected.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { password?: string };
    if (!isAuthorized(request, body.password)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const result = await settleFinalPositions();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
