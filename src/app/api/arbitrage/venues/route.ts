import { NextRequest, NextResponse } from "next/server";
import { getVenues, updateVenue } from "@/lib/arbitrage/venueStore";
import type { Venue } from "@/types/arbitrage";

export async function GET() {
  try {
    const venues = await getVenues();
    return NextResponse.json({ venues });
  } catch (error) {
    return NextResponse.json({ venues: [], error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as { id?: string } & Partial<Venue>;
    if (!body.id) {
      return NextResponse.json({ error: "Missing venue id" }, { status: 400 });
    }
    const { id, ...partial } = body;
    const updated = await updateVenue(id, partial);
    if (!updated) {
      return NextResponse.json({ error: "Venue not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, venue: updated });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
