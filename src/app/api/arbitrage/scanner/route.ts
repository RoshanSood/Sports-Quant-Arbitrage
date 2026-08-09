import { NextRequest, NextResponse } from "next/server";
import { getScannerStatus, startScanning, stopScanning } from "@/lib/arbitrage/scannerWorker";

// GET is a pure cache read — zero ingest/match/detect compute happens on this request. The
// actual work runs continuously in the background (see scannerWorker.ts); the browser just
// polls this to render the latest result.
export async function GET() {
  return NextResponse.json(getScannerStatus());
}

// Starts/stops the persistent background scan loop. Idempotent either way.
export async function POST(request: NextRequest) {
  let body: { action?: "start" | "stop" } = {};
  try {
    body = await request.json();
  } catch {
    // no body — treat as a no-op status read
  }
  if (body.action === "start") startScanning();
  else if (body.action === "stop") stopScanning();
  return NextResponse.json(getScannerStatus());
}
