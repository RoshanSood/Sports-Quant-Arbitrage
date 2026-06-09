import { NextRequest, NextResponse } from "next/server";
import { getBankrollData, setUnitSize } from "@/lib/bankrollStore";

export async function GET(request: NextRequest) {
  const date = new URL(request.url).searchParams.get("date") ?? undefined;
  try {
    const data = await getBankrollData(date);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load bankroll" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const unitSize = Number(body?.unitSize);
    if (!isFinite(unitSize) || unitSize <= 0) {
      return NextResponse.json({ error: "unitSize must be a positive number" }, { status: 400 });
    }
    await setUnitSize(unitSize);
    return NextResponse.json({ ok: true, unitSize });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update unit size" },
      { status: 500 }
    );
  }
}
