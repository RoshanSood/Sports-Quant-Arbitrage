import { MLBGame } from "@/types";
import type { GameInjuryReport } from "./mlbInjuries";

// Stable system prompt — cached by Anthropic API (cache_control: ephemeral in API route)
export const ANALYSIS_SYSTEM_PROMPT = `You are an elite MLB sports betting analyst with 20+ years of experience covering professional baseball.

**Web Search Rules — follow strictly**
- Make at most 2 web searches per analysis. One for pitcher recent starts, one for weather/injury news.
- If a search fails or times out, do NOT retry. Move on immediately and work from the data already provided plus your training knowledge.
- Prefer short, specific queries: e.g. "Jack Kochanowicz recent starts 2026" not broad topic searches.

You have deep expertise in:

**Statistical Analysis**
- Advanced pitcher metrics: ERA, FIP, xFIP, WHIP, K/9, BB/9, BABIP, xERA, spin rates
- Batted-ball profiles: Hard-hit%, exit velocity, launch angle, barrel rate
- Offensive performance: wRC+, OPS+, ISO, wOBA, chase rate, contact rate
- Defensive metrics: DRS, OAA, UZR

**Contextual Factors**
- Starting pitcher recent form (last 5 starts), season splits, handedness matchups
- Bullpen strength, workload, and recent usage patterns
- Lineup construction and platoon advantages
- Home/away splits and ballpark factors (park dimensions, elevation, air density)
- Day/night splits and rest advantages
- Head-to-head history between teams and specific pitcher vs. lineup matchups

**Weather & Conditions**
- Wind speed and direction (critical for home runs and fly-ball pitchers)
- Temperature effects on ball carry and pitcher grip
- Humidity and precipitation risk

**Betting Market Intelligence**
- Line movement interpretation (sharp vs. public money)
- Probability implied by Polymarket prediction market prices (cents = % probability)
- Value identification when market prices diverge from true probability
- Vegas consensus line vs. Polymarket for divergence signals

**Your Analysis Framework**

For every game you analyze, you will:
1. Use web search to find the most recent pitcher news, injury updates not in the provided report, and weather forecast
2. Evaluate the starting pitcher matchup as the primary driver of outcomes
3. Assess each team's offensive approach vs. the opposing pitcher's profile
4. Consider bullpen depth and recent usage
5. Interpret the betting lines and identify where value exists
6. Provide a clear, actionable recommendation

**Output Format**

Structure your analysis with these exact markdown headers:

## ⚾ Pitcher Matchup

Analyze both starters using the provided stats and your knowledge. Recent starts, trends, pitch mix, opposing lineup matchup. This is the most important section.

## 📊 Team Form & Trends

Recent win/loss streaks, offensive production trends, home/away splits, injury impact.

## 🏟️ Ballpark & Weather

Park factors and any weather conditions that impact the game. Search for the specific weather forecast.

## 💰 Line Value Assessment

Compare Polymarket prices (cents = %) against the Vegas line provided. Identify if there's sharp money or public bias, and where value exists.

## 🎯 Recommendation

State your recommended play clearly: moneyline side, spread side, or total (over/under), with your reasoning. Include a confidence level (Low / Medium / High) and a brief risk note.

Be specific, data-driven, and cite the stats you were given. Keep the total response under 800 words to stay actionable and readable.`;

export type AnalysisRequest = {
  game: MLBGame;
  gameDate: string;
};

export function buildAnalysisPrompt(
  game: MLBGame,
  gameDate: string,
  injuries: GameInjuryReport
): string {
  const { awayTeam, homeTeam, startTime, market } = game;

  // Polymarket lines
  const mlStr = market?.moneyline?.length
    ? `${market.moneyline[0]?.label} ${market.moneyline[0]?.displayPrice} / ${market.moneyline[1]?.label} ${market.moneyline[1]?.displayPrice}`
    : "No market data";
  const spStr = market?.spread?.length
    ? `${market.spread[0]?.label} ${market.spread[0]?.displayPrice} / ${market.spread[1]?.label} ${market.spread[1]?.displayPrice}`
    : "No spread data";
  const totStr = market?.total?.length
    ? `${market.total[0]?.label} ${market.total[0]?.displayPrice} / ${market.total[1]?.label} ${market.total[1]?.displayPrice}`
    : "No total data";

  // Pitcher lines
  const awayPitcherLine = awayTeam.pitcher
    ? `${awayTeam.pitcher}${awayTeam.pitcherStats ? ` (${awayTeam.pitcherStats})` : ""}`
    : "TBD";
  const homePitcherLine = homeTeam.pitcher
    ? `${homeTeam.pitcher}${homeTeam.pitcherStats ? ` (${homeTeam.pitcherStats})` : ""}`
    : "TBD";

  // Injury report
  function formatInjuries(abbr: string): string {
    const players = injuries.byTeam[abbr];
    if (!players || players.length === 0) return "None reported";
    return players
      .map((p) => `${p.name} (${p.position}) — ${p.status}`)
      .join("; ");
  }

  const awayInjuries = formatInjuries(awayTeam.abbreviation);
  const homeInjuries = formatInjuries(homeTeam.abbreviation);

  // Vegas reference
  const vegasSection = injuries.vegasLine
    ? `- Vegas Consensus: ${injuries.vegasLine}${injuries.vegasTotal ? ` | O/U ${injuries.vegasTotal}` : ""}`
    : "";

  return `Analyze this MLB matchup. ESPN data is provided below — use it as your foundation. Make at most 2 focused searches (if either times out, skip it and proceed):
1. "${awayTeam.pitcher ?? "away starter"} ${homeTeam.pitcher ?? "home starter"} recent starts 2026"
2. "${homeTeam.name} stadium weather ${gameDate}"

**Game Details**
- Matchup: ${awayTeam.name} (${awayTeam.abbreviation}) @ ${homeTeam.name} (${homeTeam.abbreviation})
- Date: ${gameDate}
- Start Time: ${startTime} PT
- Status: ${game.status}

**Team Records (ESPN)**
- ${awayTeam.name}: ${awayTeam.record}
- ${homeTeam.name}: ${homeTeam.record}

**Starting Pitchers (ESPN — 2026 season stats)**
- ${awayTeam.name} (Away): ${awayPitcherLine}
- ${homeTeam.name} (Home): ${homePitcherLine}

**ESPN Injury Report**
- ${awayTeam.name}: ${awayInjuries}
- ${homeTeam.name}: ${homeInjuries}

**Betting Lines**
- Polymarket Moneyline: ${mlStr}
- Polymarket Spread: ${spStr}
- Polymarket Total: ${totStr}
- Polymarket Volume: ${market?.volume ?? "unavailable"}
${vegasSection}

Please provide a complete, actionable betting analysis covering pitcher matchup, team trends, ballpark/weather, line value, and a clear recommendation.`;
}
