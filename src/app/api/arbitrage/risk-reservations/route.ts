import { NextResponse } from "next/server";
import { getRiskReservationService } from "@/lib/arbitrage/execution/riskReservation";
import { reconcileOutstandingReservations } from "@/lib/arbitrage/execution/reservationReconciler";

export const runtime = "nodejs";

export async function GET() {
  try {
    const reservations = getRiskReservationService().list();
    const events = getRiskReservationService().listEvents();
    return NextResponse.json({
      reservations,
      events,
      summary: {
        total: reservations.length,
        active: reservations.filter((reservation) => reservation.state !== "released").length,
        submitting: reservations.filter((reservation) => reservation.state === "submitting").length,
        uncertain: reservations.filter((reservation) => reservation.state === "uncertain").length,
        committed: reservations.filter((reservation) => reservation.state === "committed").length,
        exposureUsd: reservations
          .filter((reservation) => reservation.state !== "released")
          .reduce((sum, reservation) => sum + reservation.exposureUsd, 0),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// Read-only venue reconciliation. This endpoint never places or retries orders.
export async function POST() {
  try {
    return NextResponse.json(await reconcileOutstandingReservations());
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
