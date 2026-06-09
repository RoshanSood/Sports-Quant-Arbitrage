import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildValuePlaySystemPrompt,
  GAME_ANALYSIS_SCHEMA,
  buildMLBValuePrompt,
  buildWNBAValuePrompt,
  parseGameAnalysis,
} from "@/lib/valuePlayAnalysis";
import { fetchGameInjuryReport } from "@/lib/mlbInjuries";
import { MLBGame } from "@/types";
import { WNBAGame } from "@/types/wnba";
import { extractValuePlays } from "@/lib/valuePlayAnalysis";
import { saveRecommendations } from "@/lib/recommendationStore";
import { saveKalshiRecommendations } from "@/lib/kalshiRecommendationStore";
import { valuePlayToRecommendation } from "@/lib/gameGrader";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-7";

type DataSource = "polymarket" | "kalshi";

type RequestBody =
  | { league: "MLB"; game: MLBGame; gameDate: string; source?: DataSource }
  | { league: "WNBA"; game: WNBAGame; gameDate: string; source?: DataSource };

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ gameId: string }> }
) {
  const { gameId } = await params;

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }

  let body: RequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { league, game, gameDate } = body;
  const source: DataSource = body.source === "kalshi" ? "kalshi" : "polymarket";
  if (!game || game.id !== gameId) {
    return NextResponse.json({ error: "Game mismatch" }, { status: 400 });
  }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: { "anthropic-beta": "web-search-2025-03-05" },
  });

  try {
    let userPrompt: string;

    if (league === "MLB") {
      // Fetch MLB injury report concurrently with no extra delay
      const injuries = await fetchGameInjuryReport(gameId);
      userPrompt = buildMLBValuePrompt(game as MLBGame, gameDate, injuries, source);
    } else {
      userPrompt = buildWNBAValuePrompt(game as WNBAGame, gameDate, source);
    }

    // Use structured JSON output — no streaming, no web search for speed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (client.messages.create as any)({
      model: MODEL,
      max_tokens: 1500,
      system: buildValuePlaySystemPrompt(source),
      messages: [{ role: "user", content: userPrompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: GAME_ANALYSIS_SCHEMA,
        },
      },
    });

    const rawText: string =
      (response.content as Array<{ type: string; text?: string }>)
        .find((b) => b.type === "text")?.text ?? "{}";

    const analysis = parseGameAnalysis(rawText, gameId, league);

    // Fire-and-forget: save any value plays as tracked recommendations
    const awayTeam = league === "MLB"
      ? { name: (game as MLBGame).awayTeam.name, abbreviation: (game as MLBGame).awayTeam.abbreviation }
      : { name: (game as WNBAGame).awayTeam.name, abbreviation: (game as WNBAGame).awayTeam.abbreviation };
    const homeTeam = league === "MLB"
      ? { name: (game as MLBGame).homeTeam.name, abbreviation: (game as MLBGame).homeTeam.abbreviation }
      : { name: (game as WNBAGame).homeTeam.name, abbreviation: (game as WNBAGame).homeTeam.abbreviation };
    const startTime = league === "MLB"
      ? (game as MLBGame).startTime
      : (game as WNBAGame).startTime;

    const plays = extractValuePlays(analysis, awayTeam, homeTeam, startTime, 5);
    if (plays.length > 0) {
      const today = new Date();
      const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;

      // Look up the Polymarket price for each play from the game's market data
      const market = league === "MLB" ? (game as MLBGame).market : (game as WNBAGame).market;
      const recs = plays.map((p) => {
        let price: number | null = null;
        let displayPrice: string | null = null;
        if (market) {
          const options =
            p.market === "moneyline" ? market.moneyline
            : p.market === "spread" ? market.spread
            : market.total;
          const sideIdx = (p.market === "total"
            ? p.analysis.recommendedPick.toUpperCase().startsWith("O") ? 0 : 1
            : p.analysis.recommendedPick === p.awayAbbr ? 0 : 1);
          price = options?.[sideIdx]?.price ?? null;
          displayPrice = options?.[sideIdx]?.displayPrice ?? null;
        }
        return valuePlayToRecommendation(p, dateStr, price, displayPrice);
      });
      if (source === "kalshi") {
        saveKalshiRecommendations(recs).catch((e) => console.error("[kalshi-recs]", e));
      } else {
        saveRecommendations(recs).catch((e) => console.error("[recommendations]", e));
      }
    }

    return NextResponse.json({ analysis });
  } catch (err) {
    console.error("[value-play]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Analysis failed" },
      { status: 500 }
    );
  }
}
