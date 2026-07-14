import { NextResponse } from "next/server";
import { settleFinalPositions } from "@/lib/arbitrage/settlement";

// Settle open paper positions whose games are final (auto-settlement, manual §14).
// Idempotent — safe to call on every portfolio refresh / scan tick.
export async function POST() {
  try {
    const result = await settleFinalPositions();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
