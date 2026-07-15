import { NextRequest, NextResponse } from "next/server";
import { getVenues, updateVenue } from "@/lib/arbitrage/venueStore";
import type { Venue } from "@/types/arbitrage";
import { isAuthorized } from "@/lib/adminAuth";
import { validateVenuePatch } from "@/lib/arbitrage/validation";

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
    const body = (await request.json()) as { id?: string; password?: string } & Partial<Venue>;
    if (!isAuthorized(request, body.password)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!body.id) {
      return NextResponse.json({ error: "Missing venue id" }, { status: 400 });
    }
    const { id, password: _password, ...candidate } = body;
    void _password;
    const partial = validateVenuePatch(candidate);
    const updated = await updateVenue(id, partial);
    if (!updated) {
      return NextResponse.json({ error: "Venue not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, venue: updated });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}
