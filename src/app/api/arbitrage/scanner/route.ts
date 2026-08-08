import { NextRequest, NextResponse } from "next/server";
import { scannerStatus, startArbitrageScanner, stopArbitrageScanner } from "@/lib/arbitrage/scannerWorker";

export async function GET() {
  return NextResponse.json({ scanner: await scannerStatus() });
}

export async function PATCH(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  if (body.enabled) await startArbitrageScanner();
  else await stopArbitrageScanner();
  return NextResponse.json({ scanner: await scannerStatus() });
}
