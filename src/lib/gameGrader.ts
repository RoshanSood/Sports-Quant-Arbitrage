import {
  TrackedRecommendation,
  RecommendationStatus,
  GradeResult,
} from "@/types/performance";

const ESPN_MLB  = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";
const ESPN_WNBA = "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba";

type FinalScore = { away: number; home: number } | null;

// ── ESPN score fetch ──────────────────────────────────────────────────────────

async function fetchFinalScore(
  gameId: string,
  league: "MLB" | "WNBA"
): Promise<{ score: FinalScore; completed: boolean }> {
  const base = league === "MLB" ? ESPN_MLB : ESPN_WNBA;
  try {
    const res = await fetch(`${base}/summary?event=${gameId}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return { score: null, completed: false };

    const data = await res.json();
    const header = data.header ?? {};
    const competition = (header.competitions ?? [])[0] ?? {};

    const completed: boolean =
      competition.status?.type?.completed === true ||
      competition.status?.type?.description === "Final";

    if (!completed) return { score: null, completed: false };

    const competitors: Array<{ homeAway: string; score: string }> =
      competition.competitors ?? [];

    const awayComp = competitors.find((c) => c.homeAway === "away");
    const homeComp = competitors.find((c) => c.homeAway === "home");

    const away = awayComp ? parseInt(awayComp.score, 10) : NaN;
    const home = homeComp ? parseInt(homeComp.score, 10) : NaN;

    if (isNaN(away) || isNaN(home)) return { score: null, completed: true };
    return { score: { away, home }, completed: true };
  } catch {
    return { score: null, completed: false };
  }
}

// ── Grading logic ─────────────────────────────────────────────────────────────

function parseLineFloat(line: string | null | undefined): number | null {
  if (!line) return null;
  // Accept "+1.5", "-1.5", "8.5", "7.5", etc.
  const n = parseFloat(line.replace(/[^-+\d.]/g, ""));
  return isNaN(n) ? null : n;
}

function gradeMoneyline(
  rec: TrackedRecommendation,
  score: FinalScore
): RecommendationStatus {
  if (!score) return "void";
  const { away, home } = score;
  if (away === home) return "push"; // rare, but handle it

  const awayWon = away > home;
  if (rec.pickSide === "away") return awayWon ? "win" : "loss";
  if (rec.pickSide === "home") return awayWon ? "loss" : "win";
  return "void";
}

function gradeSpread(
  rec: TrackedRecommendation,
  score: FinalScore
): RecommendationStatus {
  if (!score) return "void";
  const { away, home } = score;
  const lineFloat = parseLineFloat(rec.line);
  if (lineFloat === null) return "void"; // can't grade without line

  // pickedScore + line vs otherScore
  const pickedScore = rec.pickSide === "away" ? away : home;
  const otherScore  = rec.pickSide === "away" ? home : away;
  const adjusted = pickedScore + lineFloat;

  if (adjusted > otherScore) return "win";
  if (adjusted < otherScore) return "loss";
  return "push";
}

function gradeTotal(
  rec: TrackedRecommendation,
  score: FinalScore
): RecommendationStatus {
  if (!score) return "void";
  const total = score.away + score.home;
  const lineFloat = parseLineFloat(rec.line);
  if (lineFloat === null) return "void";

  if (rec.pickSide === "over") {
    if (total > lineFloat) return "win";
    if (total < lineFloat) return "loss";
    return "push";
  }
  if (rec.pickSide === "under") {
    if (total < lineFloat) return "win";
    if (total > lineFloat) return "loss";
    return "push";
  }
  return "void";
}

function grade(
  rec: TrackedRecommendation,
  score: FinalScore
): RecommendationStatus {
  if (!score) return "void";
  switch (rec.marketType) {
    case "moneyline": return gradeMoneyline(rec, score);
    case "spread":    return gradeSpread(rec, score);
    case "total":     return gradeTotal(rec, score);
    default:          return "void";
  }
}

// ── Public grader ─────────────────────────────────────────────────────────────

export async function gradeRecommendations(
  pending: TrackedRecommendation[]
): Promise<GradeResult[]> {
  const results: GradeResult[] = [];

  // Batch fetch: one ESPN call per (gameId, league) combination
  const gameFetches = new Map<string, Promise<{ score: FinalScore; completed: boolean }>>();
  for (const rec of pending) {
    const key = `${rec.gameId}-${rec.league}`;
    if (!gameFetches.has(key)) {
      gameFetches.set(key, fetchFinalScore(rec.gameId, rec.league));
    }
  }

  // Wait for all fetches
  const scoreMap = new Map<string, { score: FinalScore; completed: boolean }>();
  for (const [key, p] of gameFetches) {
    scoreMap.set(key, await p);
  }

  for (const rec of pending) {
    const key = `${rec.gameId}-${rec.league}`;
    const { score, completed } = scoreMap.get(key) ?? { score: null, completed: false };

    if (!completed) continue; // game not finished yet — skip

    const status = grade(rec, score);
    const awayTeam = rec.awayTeam.abbreviation;
    const homeTeam = rec.homeTeam.abbreviation;

    let gradingNotes = `Game finished: ${awayTeam} ${score?.away ?? "?"} - ${homeTeam} ${score?.home ?? "?"}. `;
    gradingNotes += `Pick: ${rec.recommendedPick} (${rec.pickSide})`;
    if (rec.marketType === "spread") gradingNotes += ` line ${rec.line}`;
    if (rec.marketType === "total")  gradingNotes += ` total ${rec.line}`;
    gradingNotes += `. Result: ${status.toUpperCase()}.`;

    results.push({
      id: rec.id,
      status,
      finalScore: score ?? undefined,
      gradingNotes,
    });
  }

  return results;
}

// ── Factory: build TrackedRecommendation from a ValuePlay ─────────────────────

import { ValuePlay } from "@/types/analysis";
import { TrackedRecommendation as TR } from "@/types/performance";
import { generateRecId } from "./recommendationStore";

export function valuePlayToRecommendation(
  play: ValuePlay,
  date: string,
  price?: number | null,
  displayPrice?: string | null,
): TR {
  const recId = generateRecId(date, play.gameId, play.market, play.market === "total"
    ? play.analysis.recommendedPick.toLowerCase().startsWith("o") ? "over" : "under"
    : play.market === "moneyline"
      ? play.analysis.recommendedPick === play.awayAbbr ? "away" : "home"
      : "away" // spread side derived below
  );

  // Derive pickSide from market + recommendedPick label
  let pickSide: TR["pickSide"] = "home";
  const pick = play.analysis.recommendedPick;

  if (play.market === "total") {
    pickSide = pick.toUpperCase().startsWith("O") ? "over" : "under";
  } else if (play.market === "moneyline") {
    // pick is the team abbreviation, e.g. "TOR"
    pickSide = pick.toUpperCase() === play.awayAbbr.toUpperCase() ? "away" : "home";
  } else if (play.market === "spread") {
    // pick is "TOR -1.5" or "LAA +1.5"
    const abbrInPick = pick.split(" ")[0]?.toUpperCase();
    pickSide = abbrInPick === play.awayAbbr.toUpperCase() ? "away" : "home";
  }

  // Extract numeric line from pick label
  let line: string | null = null;
  if (play.market === "spread") {
    const m = pick.match(/([+-]?\d+\.5)/);
    line = m ? m[1] : null;
  } else if (play.market === "total") {
    const m = pick.match(/(\d+\.?\d*)/g);
    line = m ? m[m.length - 1] : null;
  }

  return {
    id: recId,
    gameId: play.gameId,
    league: play.league,
    date,
    startTime: play.startTime,
    awayTeam: { name: play.awayTeam, abbreviation: play.awayAbbr },
    homeTeam: { name: play.homeTeam, abbreviation: play.homeAbbr },
    marketType: play.market,
    recommendedPick: pick,
    pickSide,
    line,
    price: price ?? null,
    displayPrice: displayPrice ?? null,
    confidence: play.analysis.confidence,
    rating: play.analysis.rating,
    valueScore: play.analysis.valueScore,
    reasoningSummary: play.analysis.edgeSummary,
    risks: play.analysis.risks,
    source: "value_plays",
    generatedAt: new Date().toISOString(),
    status: "pending",
    finalScore: null,
    gradedAt: null,
    gradingNotes: null,
  };
}
