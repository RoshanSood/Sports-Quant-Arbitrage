import { NextResponse } from "next/server";
import { getPendingRecommendations, updateRecommendation } from "@/lib/recommendationStore";
import { gradeRecommendations } from "@/lib/gameGrader";
import { updateBankrollBetStatus } from "@/lib/bankrollStore";

export async function POST() {
  try {
    const pending = await getPendingRecommendations();
    if (!pending.length) {
      return NextResponse.json({ graded: 0, message: "No pending recommendations" });
    }

    const results = await gradeRecommendations(pending);
    const gradedAt = new Date().toISOString();

    // Persist each graded result
    for (const result of results) {
      await updateRecommendation(result.id, {
        status: result.status,
        finalScore: result.finalScore ?? null,
        gradedAt,
        gradingNotes: result.gradingNotes,
      });
      await updateBankrollBetStatus(result.id, result.status).catch((e) =>
        console.error("[bankroll-grade]", e)
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
    console.error("[grade-recommendations]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Grading failed" },
      { status: 500 }
    );
  }
}
