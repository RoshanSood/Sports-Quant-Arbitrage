import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  findPitcherIds,
  fetchPitcherDetails,
  fetchPitcherSeasonStats,
  fetchPitcherGameLogs,
  computeRecentForm,
  mlbHeadshotUrl,
} from "@/lib/mlbStatsApi";
import { MLBGame } from "@/types";
import { PitcherMatchupData, PitcherMatchupAnalysis } from "@/types/pitcherMatchup";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-7";
const SEASON = new Date().getFullYear();

// JSON schema for Claude's structured analysis output
const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    edge: { type: "string", enum: ["away", "home", "push"] },
    edgeLabel: { type: "string" },
    edgeSummary: { type: "string" },
    awayPitcherAssessment: { type: "string" },
    homePitcherAssessment: { type: "string" },
    moneylineImpact: { type: "string", enum: ["away", "home", "neutral"] },
    spreadImpact: { type: "string", enum: ["away", "home", "neutral"] },
    totalImpact: { type: "string", enum: ["over", "under", "neutral"] },
    totalImpactReason: { type: "string" },
    keyFactors: { type: "array", items: { type: "string" } },
    bettingConclusion: { type: "string" },
  },
  required: [
    "edge", "edgeLabel", "edgeSummary",
    "awayPitcherAssessment", "homePitcherAssessment",
    "moneylineImpact", "spreadImpact", "totalImpact",
    "totalImpactReason", "keyFactors", "bettingConclusion",
  ],
  additionalProperties: false,
};

function formatStats(stats: ReturnType<typeof Object.create> | null, name: string): string {
  if (!stats) return `${name}: Stats unavailable`;
  const s = stats as Record<string, string | number | null>;
  return [
    `${name}:`,
    `  Season: ${s.wins ?? "?"}W-${s.losses ?? "?"}L, ${s.era ?? "?"} ERA, ${s.whip ?? "?"} WHIP`,
    `  ${s.gamesStarted ?? "?"} GS, ${s.inningsPitched ?? "?"} IP`,
    `  K/9: ${s.strikeoutsPer9 ?? "?"} | BB/9: ${s.walksPer9 ?? "?"} | HR/9: ${s.homeRunsPer9 ?? "?"}`,
    `  BAA: ${s.battingAverageAgainst ?? "?"} | K/BB: ${s.strikeoutWalkRatio ?? "?"}`,
  ].join("\n");
}

function formatRecentForm(form: ReturnType<typeof computeRecentForm> | null, name: string): string {
  if (!form || !form.last3Starts.length) return `${name} recent form: No recent starts`;
  const s = form.last3Summary;
  const lines = form.last3Starts.map(
    (g) => `  ${g.date} vs ${g.opponent}: ${g.inningsPitched ?? "?"} IP, ${g.earnedRuns ?? "?"} ER, ${g.strikeouts ?? "?"}K, ${g.walks ?? "?"}BB${g.decision ? ` (${g.decision})` : ""}`
  );
  return [
    `${name} last 3 starts (${form.formLabel}):`,
    ...lines,
    `  L3 totals: ${s.inningsPitched ?? "?"} IP, ${s.earnedRuns ?? "?"} ER, ${s.strikeouts ?? "?"}K, ${s.walks ?? "?"}BB | ERA: ${s.era ?? "?"} WHIP: ${s.whip ?? "?"}`,
  ].join("\n");
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ gameId: string }> }
) {
  const { gameId } = await params;

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }

  let body: { game: MLBGame; gameDate: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { game, gameDate } = body;
  if (!game || game.id !== gameId) {
    return NextResponse.json({ error: "Game mismatch" }, { status: 400 });
  }

  // ── Step 1: Find MLB Stats API pitcher IDs ────────────────────────────────
  // gameDate is "Sat, May 10" — convert to YYYY-MM-DD for MLB API
  const dateParts = game.date || gameDate; // game.date is already "YYYY-MM-DD" from ESPN
  const mlbDate = game.date.includes("-") ? game.date : (() => {
    const d = new Date(gameDate + " 2026");
    return d.toISOString().split("T")[0];
  })();

  const { awayId, homeId } = await findPitcherIds(
    mlbDate,
    game.awayTeam.abbreviation,
    game.homeTeam.abbreviation,
    game.awayTeam.pitcher,
    game.homeTeam.pitcher
  );

  // ── Step 2: Fetch pitcher details + stats concurrently ───────────────────
  const [
    awayDetails,
    homeDetails,
    awayStats,
    homeStats,
    awayLogs,
    homeLogs,
  ] = await Promise.all([
    awayId ? fetchPitcherDetails(awayId, game.awayTeam.name, game.awayTeam.abbreviation) : null,
    homeId ? fetchPitcherDetails(homeId, game.homeTeam.name, game.homeTeam.abbreviation) : null,
    awayId ? fetchPitcherSeasonStats(awayId, SEASON) : null,
    homeId ? fetchPitcherSeasonStats(homeId, SEASON) : null,
    awayId ? fetchPitcherGameLogs(awayId, SEASON) : Promise.resolve([]),
    homeId ? fetchPitcherGameLogs(homeId, SEASON) : Promise.resolve([]),
  ]);

  // Fallback for details when ID not found but name is known from ESPN
  const awayPitcherInfo = awayDetails ?? (game.awayTeam.pitcher ? {
    id: null,
    fullName: game.awayTeam.pitcher,
    teamName: game.awayTeam.name,
    teamAbbreviation: game.awayTeam.abbreviation,
    throws: "Unknown" as const,
    headshot: null,
  } : null);

  const homePitcherInfo = homeDetails ?? (game.homeTeam.pitcher ? {
    id: null,
    fullName: game.homeTeam.pitcher,
    teamName: game.homeTeam.name,
    teamAbbreviation: game.homeTeam.abbreviation,
    throws: "Unknown" as const,
    headshot: null,
  } : null);

  const awayForm = awayLogs.length ? computeRecentForm(awayLogs) : null;
  const homeForm = homeLogs.length ? computeRecentForm(homeLogs) : null;

  // ── Step 3: Claude analysis ───────────────────────────────────────────────
  const awayName = awayPitcherInfo?.fullName ?? game.awayTeam.pitcher ?? "TBD";
  const homeName = homePitcherInfo?.fullName ?? game.homeTeam.pitcher ?? "TBD";

  const ml = game.market?.moneyline ?? [];
  const sp = game.market?.spread ?? [];
  const tot = game.market?.total ?? [];

  const marketContext = [
    ml.length ? `Moneyline: ${ml[0]?.label} ${ml[0]?.displayPrice} / ${ml[1]?.label} ${ml[1]?.displayPrice}` : "Moneyline: N/A",
    sp.length ? `Spread: ${sp[0]?.label} ${sp[0]?.displayPrice} / ${sp[1]?.label} ${sp[1]?.displayPrice}` : "Spread: N/A",
    tot.length ? `Total: ${tot[0]?.label} ${tot[0]?.displayPrice} / ${tot[1]?.label} ${tot[1]?.displayPrice}` : "Total: N/A",
  ].join("\n");

  const pitcherContext = [
    `Away Pitcher: ${awayName} (${game.awayTeam.abbreviation})`,
    `${awayPitcherInfo ? `  Throws: ${awayPitcherInfo.throws}${awayPitcherInfo.age ? `, Age ${awayPitcherInfo.age}` : ""}` : ""}`,
    formatStats(awayStats, `${awayName} Season Stats`),
    awayStats ? "" : `  ESPN season line: ${game.awayTeam.pitcherStats ?? "unavailable"}`,
    formatRecentForm(awayForm, `${awayName}`),
    "",
    `Home Pitcher: ${homeName} (${game.homeTeam.abbreviation})`,
    `${homePitcherInfo ? `  Throws: ${homePitcherInfo.throws}${homePitcherInfo.age ? `, Age ${homePitcherInfo.age}` : ""}` : ""}`,
    formatStats(homeStats, `${homeName} Season Stats`),
    homeStats ? "" : `  ESPN season line: ${game.homeTeam.pitcherStats ?? "unavailable"}`,
    formatRecentForm(homeForm, `${homeName}`),
  ].filter((l) => l !== undefined).join("\n");

  const prompt = `Analyze this MLB starting pitcher matchup and return a JSON assessment.

GAME: ${game.awayTeam.abbreviation} @ ${game.homeTeam.abbreviation} | ${game.startTime} PT | ${mlbDate}
Records: ${game.awayTeam.abbreviation} ${game.awayTeam.record} | ${game.homeTeam.abbreviation} ${game.homeTeam.record}

PITCHER DATA (from MLB Stats API — do NOT invent stats; if data shows "unavailable" say so):
${pitcherContext}

BETTING LINES:
${marketContext}

Analyze the pitching matchup. Consider:
- Which pitcher has the statistical edge?
- How does recent form affect confidence?
- Does the handedness/stuff favor either team's lineup?
- How should this affect moneyline, spread, and total?
- Is there value given the Polymarket price?

If stats are unavailable, acknowledge it and reason from the ESPN season line provided (W-L, ERA).
Return ONLY valid JSON. No markdown.`;

  let analysis: PitcherMatchupAnalysis | null = null;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (client.messages.create as any)({
      model: MODEL,
      max_tokens: 1000,
      system: "You are a baseball analyst specializing in starting pitcher evaluation. Respond only with valid JSON matching the schema provided. Do not invent statistics.",
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: { type: "json_schema", schema: ANALYSIS_SCHEMA },
      },
    });

    const rawText: string =
      (response.content as Array<{ type: string; text?: string }>)
        .find((b) => b.type === "text")?.text ?? "{}";

    analysis = JSON.parse(rawText) as PitcherMatchupAnalysis;
  } catch (err) {
    console.error("[pitcher-matchup] Claude error:", err);
  }

  const result: PitcherMatchupData = {
    gameId,
    date: mlbDate,
    awayTeam: {
      name: game.awayTeam.name,
      abbreviation: game.awayTeam.abbreviation,
      pitcher: awayPitcherInfo,
    },
    homeTeam: {
      name: game.homeTeam.name,
      abbreviation: game.homeTeam.abbreviation,
      pitcher: homePitcherInfo,
    },
    awayPitcherStats: awayStats,
    homePitcherStats: homeStats,
    awayPitcherRecentForm: awayForm,
    homePitcherRecentForm: homeForm,
    analysis,
  };

  return NextResponse.json({ matchup: result });
}

