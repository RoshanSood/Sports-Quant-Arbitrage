import { MLBGame } from "@/types";
import { WNBAGame } from "@/types/wnba";
import type { GameInjuryReport } from "./mlbInjuries";
import { GameAnalysis } from "@/types/analysis";

type DataSource = "polymarket" | "kalshi";

function sourceName(source: DataSource): string {
  return source === "kalshi" ? "Kalshi" : "Polymarket";
}

// Compact system prompt — no streaming, no web search, JSON output only
export function buildValuePlaySystemPrompt(source: DataSource = "polymarket"): string {
  const name = sourceName(source);
  return `You are a sharp sports betting analyst. Your job is to evaluate betting markets and identify where the price is wrong — where the implied probability differs meaningfully from the true probability given the available data.

**Rules for value plays**
- Mark isValuePlay=true only when you genuinely see an edge — the market price does not reflect reality.
- Do NOT mark every recommendation as a value play. Be selective.
- Confidence 1–10: how certain you are about the outcome.
- ValueScore 1–10: size of the edge (1=tiny, 10=massive).
- Rating: "safe" (6+ confidence, small edge, reliable), "lean" (moderate edge), "risky" (real edge but high variance), "avoid" (no edge or wrong side).
- For markets with no data: set isValuePlay=false, confidence=0, rating="avoid", reasoning="No market available".

**How to find value**
- Compare the ${name} implied probability (price in cents = %) against what the true probability should be.
- A price gap of 5+ percentage points with a clear reason = value play.
- Factor in: pitching matchup (MLB), injury asymmetry, home/away advantage, team record, known market biases.

Return ONLY a valid JSON object matching the schema. No explanation, no markdown, no code blocks.`;
}

// Keep export for any callers that haven't been updated yet
export const VALUE_PLAY_SYSTEM_PROMPT = buildValuePlaySystemPrompt("polymarket");

// Full JSON schema passed to Claude via output_config.format
export const GAME_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    gameId: { type: "string" },
    league: { type: "string", enum: ["MLB", "WNBA"] },
    summary: { type: "string" },
    moneyline: {
      type: "object",
      properties: {
        recommendedPick: { type: "string" },
        confidence: { type: "number" },
        rating: { type: "string", enum: ["safe", "lean", "risky", "avoid"] },
        isValuePlay: { type: "boolean" },
        valueScore: { type: "number" },
        edgeSummary: { type: "string" },
        reasoning: { type: "string" },
        risks: { type: "array", items: { type: "string" } },
      },
      required: ["recommendedPick", "confidence", "rating", "isValuePlay", "valueScore", "edgeSummary", "reasoning", "risks"],
      additionalProperties: false,
    },
    spread: {
      type: "object",
      properties: {
        recommendedPick: { type: "string" },
        confidence: { type: "number" },
        rating: { type: "string", enum: ["safe", "lean", "risky", "avoid"] },
        isValuePlay: { type: "boolean" },
        valueScore: { type: "number" },
        edgeSummary: { type: "string" },
        reasoning: { type: "string" },
        risks: { type: "array", items: { type: "string" } },
      },
      required: ["recommendedPick", "confidence", "rating", "isValuePlay", "valueScore", "edgeSummary", "reasoning", "risks"],
      additionalProperties: false,
    },
    total: {
      type: "object",
      properties: {
        recommendedPick: { type: "string" },
        confidence: { type: "number" },
        rating: { type: "string", enum: ["safe", "lean", "risky", "avoid"] },
        isValuePlay: { type: "boolean" },
        valueScore: { type: "number" },
        edgeSummary: { type: "string" },
        reasoning: { type: "string" },
        risks: { type: "array", items: { type: "string" } },
      },
      required: ["recommendedPick", "confidence", "rating", "isValuePlay", "valueScore", "edgeSummary", "reasoning", "risks"],
      additionalProperties: false,
    },
    keyFactors: { type: "array", items: { type: "string" } },
    injuryNotes: { type: "array", items: { type: "string" } },
    pitcherNotes: { type: "array", items: { type: "string" } },
    playerNotes: { type: "array", items: { type: "string" } },
    bullpenNotes: { type: "array", items: { type: "string" } },
    weatherNotes: { type: "array", items: { type: "string" } },
    finalTakeaway: { type: "string" },
  },
  required: ["gameId", "league", "summary", "moneyline", "spread", "total", "keyFactors", "injuryNotes", "pitcherNotes", "playerNotes", "bullpenNotes", "weatherNotes", "finalTakeaway"],
  additionalProperties: false,
};

// ── MLB prompt ──────────────────────────────────────────────────────────────

export function buildMLBValuePrompt(
  game: MLBGame,
  gameDate: string,
  injuries: GameInjuryReport,
  source: DataSource = "polymarket"
): string {
  const { awayTeam, homeTeam, startTime, market } = game;

  const ml = market?.moneyline ?? [];
  const sp = market?.spread ?? [];
  const tot = market?.total ?? [];

  const mlStr = ml.length
    ? `${ml[0]?.label} ${ml[0]?.displayPrice} (${ml[0]?.price != null ? Math.round(ml[0].price * 100) : "?"}% implied) / ${ml[1]?.label} ${ml[1]?.displayPrice} (${ml[1]?.price != null ? Math.round(ml[1].price * 100) : "?"}% implied)`
    : "No moneyline data";
  const spStr = sp.length
    ? `${sp[0]?.label} ${sp[0]?.displayPrice} / ${sp[1]?.label} ${sp[1]?.displayPrice}`
    : "No spread data";
  const totStr = tot.length
    ? `${tot[0]?.label} ${tot[0]?.displayPrice} / ${tot[1]?.label} ${tot[1]?.displayPrice}`
    : "No total data";

  const awayPitcher = awayTeam.pitcher
    ? `${awayTeam.pitcher}${awayTeam.pitcherStats ? ` (${awayTeam.pitcherStats})` : ""}`
    : "TBD";
  const homePitcher = homeTeam.pitcher
    ? `${homeTeam.pitcher}${homeTeam.pitcherStats ? ` (${homeTeam.pitcherStats})` : ""}`
    : "TBD";

  const fmtInj = (abbr: string) => {
    const ps = injuries.byTeam[abbr];
    if (!ps || ps.length === 0) return "None";
    return ps.map((p) => `${p.name} (${p.status})`).join(", ");
  };

  const vegasRef = injuries.vegasLine
    ? `Vegas: ${injuries.vegasLine}${injuries.vegasTotal ? ` | O/U ${injuries.vegasTotal}` : ""}`
    : "Vegas line unavailable";

  const name = sourceName(source);

  return `Analyze this MLB game and identify value plays. Return a JSON GameAnalysis object.

gameId: "${game.id}"
league: "MLB"
Date: ${gameDate} | Time: ${startTime} PT

TEAMS
- Away: ${awayTeam.name} (${awayTeam.abbreviation}) — ${awayTeam.record}
- Home: ${homeTeam.name} (${homeTeam.abbreviation}) — ${homeTeam.record}

STARTING PITCHERS (2026 season stats)
- Away SP: ${awayPitcher}
- Home SP: ${homePitcher}

INJURIES
- ${awayTeam.abbreviation}: ${fmtInj(awayTeam.abbreviation)}
- ${homeTeam.abbreviation}: ${fmtInj(homeTeam.abbreviation)}

${name.toUpperCase()} BETTING LINES
- Moneyline: ${mlStr}
- Spread: ${spStr}
- Total: ${totStr}
- Volume: ${market?.volume ?? "unavailable"}
- ${vegasRef}

Identify where the ${name} price diverges from true probability. For markets with no data, set isValuePlay=false.`;
}

// ── WNBA prompt ─────────────────────────────────────────────────────────────

export function buildWNBAValuePrompt(
  game: WNBAGame,
  gameDate: string,
  source: DataSource = "polymarket"
): string {
  const { awayTeam, homeTeam, startTime, market } = game;
  const name = sourceName(source);

  const ml = market?.moneyline ?? [];
  const sp = market?.spread ?? [];
  const tot = market?.total ?? [];

  const mlStr = ml.length
    ? `${ml[0]?.label} ${ml[0]?.displayPrice} (${ml[0]?.price != null ? Math.round(ml[0].price * 100) : "?"}% implied) / ${ml[1]?.label} ${ml[1]?.displayPrice} (${ml[1]?.price != null ? Math.round(ml[1].price * 100) : "?"}% implied)`
    : "No moneyline data";
  const spStr = sp.length
    ? `${sp[0]?.label} ${sp[0]?.displayPrice} / ${sp[1]?.label} ${sp[1]?.displayPrice}`
    : "No spread data";
  const totStr = tot.length
    ? `${tot[0]?.label} ${tot[0]?.displayPrice} / ${tot[1]?.label} ${tot[1]?.displayPrice}`
    : "No total data";

  const fmtInj = (team: typeof awayTeam) => {
    if (!team.injuries || team.injuries.length === 0) return "None";
    return team.injuries.map((p) => `${p.name} (${p.position}, ${p.status})`).join(", ");
  };

  const hasSpreadTotal = source === "kalshi";
  const spreadTotalNote = hasSpreadTotal
    ? "Analyze spread and total markets where data is available."
    : `WNBA on ${name} only has moneyline — set spread and total to isValuePlay=false, confidence=0, rating="avoid", reasoning="No ${name} market available for WNBA spread/total".`;

  return `Analyze this WNBA game and identify value plays. ${spreadTotalNote} Return a JSON GameAnalysis object.

gameId: "${game.id}"
league: "WNBA"
Date: ${gameDate} | Time: ${startTime} PT

TEAMS
- Away: ${awayTeam.name} (${awayTeam.abbreviation}) — ${awayTeam.record}
- Home: ${homeTeam.name} (${homeTeam.abbreviation}) — ${homeTeam.record}

INJURIES (from ESPN)
- ${awayTeam.abbreviation}: ${fmtInj(awayTeam)}
- ${homeTeam.abbreviation}: ${fmtInj(homeTeam)}

${name.toUpperCase()} BETTING LINES
- Moneyline: ${mlStr}
- Spread: ${spStr}
- Total: ${totStr}
- Volume: ${market?.volume ?? "unavailable"}

Identify where the ${name} price diverges from true probability given injury asymmetry and team quality.`;
}

// ── Parse helper ─────────────────────────────────────────────────────────────

export function parseGameAnalysis(raw: string, gameId: string, league: "MLB" | "WNBA"): GameAnalysis {
  try {
    const parsed = JSON.parse(raw) as GameAnalysis;
    // Ensure required top-level arrays are present
    return {
      gameId,
      league,
      summary: parsed.summary ?? "",
      moneyline: parsed.moneyline,
      spread: parsed.spread,
      total: parsed.total,
      keyFactors: parsed.keyFactors ?? [],
      injuryNotes: parsed.injuryNotes ?? [],
      pitcherNotes: parsed.pitcherNotes ?? [],
      playerNotes: parsed.playerNotes ?? [],
      bullpenNotes: parsed.bullpenNotes ?? [],
      weatherNotes: parsed.weatherNotes ?? [],
      finalTakeaway: parsed.finalTakeaway ?? "",
    };
  } catch {
    throw new Error(`Failed to parse GameAnalysis JSON: ${raw.slice(0, 200)}`);
  }
}

// Utility: extract value plays from a completed analysis
export function extractValuePlays(
  analysis: GameAnalysis,
  awayTeam: { name: string; abbreviation: string },
  homeTeam: { name: string; abbreviation: string },
  startTime: string,
  minConfidence = 6
) {
  const plays = [];
  const markets: Array<["moneyline" | "spread" | "total", typeof analysis.moneyline]> = [
    ["moneyline", analysis.moneyline],
    ["spread", analysis.spread],
    ["total", analysis.total],
  ];

  for (const [market, ma] of markets) {
    if (
      ma.isValuePlay &&
      ma.confidence >= minConfidence &&
      ma.rating !== "avoid"
    ) {
      plays.push({
        gameId: analysis.gameId,
        league: analysis.league,
        awayTeam: awayTeam.name,
        homeTeam: homeTeam.name,
        awayAbbr: awayTeam.abbreviation,
        homeAbbr: homeTeam.abbreviation,
        startTime,
        market,
        analysis: ma,
        fullAnalysis: analysis,
      });
    }
  }
  return plays;
}
