import Anthropic from "@anthropic-ai/sdk";
import { fetchESPNGames } from "./espn";
import { fetchPolymarketData } from "./polymarket";
import { fetchKalshiData } from "./kalshi";
import { fetchWNBAGames } from "./wnbaEspn";
import { fetchWNBAPolymarketData } from "./wnbaPolymarket";
import {
  buildValuePlaySystemPrompt,
  GAME_ANALYSIS_SCHEMA,
  buildMLBValuePrompt,
  buildWNBAValuePrompt,
  parseGameAnalysis,
  extractValuePlays,
} from "./valuePlayAnalysis";
import { fetchGameInjuryReport } from "./mlbInjuries";
import { saveRecommendations } from "./recommendationStore";
import { saveKalshiRecommendations } from "./kalshiRecommendationStore";
import { valuePlayToRecommendation } from "./gameGrader";
import { setCached, setRunning } from "./valuePlaysCache";
import { ValuePlay, ValuePlaysCacheEntry } from "@/types/analysis";
import { MLBGame } from "@/types";
import { WNBAGame } from "@/types/wnba";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-7";
const CONCURRENCY = 3;

type DataSource = "polymarket" | "kalshi";

type GameEntry =
  | { league: "MLB"; game: MLBGame }
  | { league: "WNBA"; game: WNBAGame };

async function analyzeEntry(
  entry: GameEntry,
  date: string,
  source: DataSource,
  client: Anthropic
): Promise<ValuePlay[]> {
  let userPrompt: string;

  if (entry.league === "MLB") {
    const injuries = await fetchGameInjuryReport(entry.game.id);
    userPrompt = buildMLBValuePrompt(entry.game as MLBGame, date, injuries, source);
  } else {
    userPrompt = buildWNBAValuePrompt(entry.game as WNBAGame, date, source);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await (client.messages.create as any)({
    model: MODEL,
    max_tokens: 1500,
    system: buildValuePlaySystemPrompt(source),
    messages: [{ role: "user", content: userPrompt }],
    output_config: {
      format: { type: "json_schema", schema: GAME_ANALYSIS_SCHEMA },
    },
  });

  const rawText: string =
    (response.content as Array<{ type: string; text?: string }>)
      .find((b) => b.type === "text")?.text ?? "{}";

  const analysis = parseGameAnalysis(rawText, entry.game.id, entry.league);
  const away = { name: entry.game.awayTeam.name, abbreviation: entry.game.awayTeam.abbreviation };
  const home = { name: entry.game.homeTeam.name, abbreviation: entry.game.homeTeam.abbreviation };
  return extractValuePlays(analysis, away, home, entry.game.startTime, 5);
}

async function processQueue<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < items.length) {
        await fn(items[i++]);
      }
    })
  );
}

export async function runValuePlaysForDate(
  date: string, // YYYYMMDD
  source: DataSource
): Promise<ValuePlaysCacheEntry> {
  setRunning(date, source, true);

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY not configured");
    }

    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      defaultHeaders: { "anthropic-beta": "web-search-2025-03-05" },
    });

    // ── Fetch MLB games with market data ─────────────────────────────────────
    const espnGames = await fetchESPNGames(date).catch(() => [] as Awaited<ReturnType<typeof fetchESPNGames>>);

    let mlbMarketMap: Awaited<ReturnType<typeof fetchPolymarketData>>;
    if (source === "kalshi") {
      const polyMap = await fetchPolymarketData(espnGames).catch(() => new Map());
      const spreadHints = new Map<string, { abbr: string; line: number }>();
      for (const [gameId, m] of polyMap) {
        if (m.spread.length > 0) {
          const match = m.spread[0].label.match(/^(\S+)\s+[+-](\d+(?:\.\d+)?)$/);
          if (match) spreadHints.set(gameId, { abbr: match[1], line: parseFloat(match[2]) });
        }
      }
      mlbMarketMap = await fetchKalshiData(espnGames, spreadHints).catch(() => new Map());
    } else {
      mlbMarketMap = await fetchPolymarketData(espnGames).catch(() => new Map());
    }

    const mlbEntries: GameEntry[] = espnGames.map((g) => ({
      league: "MLB" as const,
      game: { ...g, market: mlbMarketMap.get(g.id) ?? null } as MLBGame,
    }));

    // ── Fetch WNBA games (Polymarket only) ───────────────────────────────────
    let wnbaEntries: GameEntry[] = [];
    if (source !== "kalshi") {
      const wnbaRaw = await fetchWNBAGames(date).catch(() => [] as Awaited<ReturnType<typeof fetchWNBAGames>>);
      const wnbaMarketMap = await fetchWNBAPolymarketData(wnbaRaw).catch(() => new Map());
      wnbaEntries = wnbaRaw.map((g) => ({
        league: "WNBA" as const,
        game: { ...g, market: wnbaMarketMap.get(g.id) ?? null } as WNBAGame,
      }));
    }

    const allEntries: GameEntry[] = [...mlbEntries, ...wnbaEntries];
    const allPlays: ValuePlay[] = [];
    let analyzedCount = 0;

    await processQueue(allEntries, CONCURRENCY, async (entry) => {
      try {
        const plays = await analyzeEntry(entry, date, source, client);
        analyzedCount++;

        if (plays.length > 0) {
          allPlays.push(...plays);

          const market = entry.game.market;
          const recs = plays.map((p) => {
            let price: number | null = null;
            let displayPrice: string | null = null;
            if (market) {
              const options =
                p.market === "moneyline" ? market.moneyline
                : p.market === "spread" ? market.spread
                : market.total;
              const sideIdx =
                p.market === "total"
                  ? p.analysis.recommendedPick.toUpperCase().startsWith("O") ? 0 : 1
                  : p.analysis.recommendedPick === p.awayAbbr ? 0 : 1;
              price = options?.[sideIdx]?.price ?? null;
              displayPrice = options?.[sideIdx]?.displayPrice ?? null;
            }
            return valuePlayToRecommendation(p, date, price, displayPrice);
          });

          if (source === "kalshi") {
            await saveKalshiRecommendations(recs).catch((e) => console.error("[runner/kalshi-recs]", e));
          } else {
            await saveRecommendations(recs).catch((e) => console.error("[runner/recs]", e));
          }
        }
      } catch (err) {
        console.error(`[runner] game ${entry.game.id} (${entry.league}) failed:`, err);
      }
    });

    allPlays.sort((a, b) => b.analysis.confidence - a.analysis.confidence);

    const cacheEntry: ValuePlaysCacheEntry = {
      plays: allPlays,
      gameCount: allEntries.length,
      analyzedCount,
      generatedAt: new Date().toISOString(),
      source,
      date,
    };

    await setCached(date, source, cacheEntry);
    console.log(`[runner] ${source} ${date}: ${allPlays.length} plays from ${analyzedCount}/${allEntries.length} games`);
    return cacheEntry;
  } finally {
    setRunning(date, source, false);
  }
}
