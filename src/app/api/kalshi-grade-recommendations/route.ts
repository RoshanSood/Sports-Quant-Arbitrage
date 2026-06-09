import { NextResponse } from "next/server";
import {
  getPendingKalshiRecommendations,
  updateKalshiRecommendation,
} from "@/lib/kalshiRecommendationStore";
import { gradeRecommendations } from "@/lib/gameGrader";
import { updateKalshiBankrollBetStatus } from "@/lib/kalshiBankrollStore";

export async function POST() {
  try {
    const pending = await getPendingKalshiRecommendations();
    if (!pending.length) {
      return NextResponse.json({ graded: 0, message: "No pending Kalshi recommendations" });
    }

    const results = await gradeRecommendations(pending);
    const gradedAt = new Date().toISOString();

    for (const result of results) {
      await updateKalshiRecommendation(result.id, {
        status: result.status,
        finalScore: result.finalScore ?? null,
        gradedAt,
        gradingNotes: result.gradingNotes,
      });
      await updateKalshiBankrollBetStatus(result.id, result.status).catch((e) =>
        console.error("[kalshi-bankroll-grade]", e)
      );
    }

    return NextResponse.json({
      graded: results.length,
      pending: pending.length,
      results: results.map((r) => ({
        id: r.id,
        status: r.status,
        finalScore: r.finalScore,
        gradingNotes: r.gradingNotes,
      })),
    });
  } catch (err) {
    console.error("[kalshi-grade-recommendations]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Grading failed" },
      { status: 500 }
    );
  }
}
